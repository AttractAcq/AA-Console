/**
 * The publisher.
 *
 * M2, and the only thing in this system that makes a client's account say
 * something in public. A sweep rather than a job per post: what is due is a
 * question about the clock, not about a slot, and one claim of five posts is
 * one lease instead of five.
 *
 * OFF IS A STATE, NOT AN ERROR
 *
 * With PUBLISH_ENABLED unset this does nothing and says so, successfully.
 * Not a dry run that pretends: a dry run that "succeeds" would have the
 * database write published_at and move the slot to published for a post that
 * never went out, which is a lie told in the one place a person checks. If
 * publishing is off, nothing is claimed.
 *
 * The flag is deliberately the second of two. The first is per client, in
 * the database, so that turning publishing on for one account is not turning
 * it on for every account the engine has ever planned a slot for.
 *
 * ONE POST'S FAILURE IS ITS OWN
 *
 * A sweep that threw on the first bad post would leave the other four
 * claimed and stranded for the reaper to fail. Each post is recorded where
 * it got to before the next is attempted.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { logger } from "../../logging/logger.js";
import { isPlatform } from "../../content/platform-limits.js";
import { MAX_FRAMES, MIN_FRAMES, isContentFormat } from "../../content/format.js";
import { adapterFor } from "../../publishing/registry.js";
import { compose } from "../../publishing/caption.js";
import { PROVIDER_MEDIA_FETCH_URL_TTL_SECONDS, safeProviderErrorMessage } from "../../storage/signed-url-policy.js";
import { requireOrganicRoute } from "./organic-route.js";
import {
  PublishError,
  type PublishAdapter,
  type PublishFrame,
  type PublishRequest,
  type PublishSuccess,
} from "../../publishing/types.js";

const MEDIA_BUCKET = "client-media";
const DEFAULT_BATCH = 5;

export interface ClaimedPost {
  post_id: string;
  client_id: string;
  platform: string;
  provider: string;
  media_type: string | null;
  media_path: string | null;
  content_format: string | null;
  /** Ordered by position. Null for anything that is not a frame set. */
  frame_paths: string[] | null;
  asset_id: string | null;
  caption: string | null;
  hashtags: string[] | null;
  alt_text: string | null;
  link_url: string | null;
  first_comment: string | null;
  scheduled_at: string;
  attempt: number;
}

/**
 * The SQL claim is not an external-write grant. In particular, a legacy
 * `approve_slot` can create a slot-backed post without a canonical outgoing
 * decision. Migration 292 deliberately refuses this RPC for every post until
 * a byte-bound AAL2 decision and prewrite check are implemented. Keep this
 * call before any integration, token, signed URL or provider operation.
 */
export async function requireOutgoingPublicationPrewrite(
  sb: SupabaseClient,
  postId: string,
): Promise<void> {
  const { data, error } = await sb.rpc("require_organic_publication_prewrite_v6", {
    p_post_id: postId,
  } as never);
  const artifactHash = (data as { artifact_hash?: unknown } | null)?.artifact_hash;
  if (error || typeof artifactHash !== "string" || !/^[0-9a-f]{64}$/.test(artifactHash)) {
    throw new PublishError(
      `Exact outgoing publication approval is unavailable: ${error?.message ?? "no approved package"}`,
      false,
    );
  }
}

/** Everything that can stop one post, before anything is sent. */
export async function prepare(
  sb: SupabaseClient,
  post: ClaimedPost,
): Promise<PublishRequest> {
  await requireOutgoingPublicationPrewrite(sb, post.post_id);
  await requireOrganicRoute(sb, post);
  if (!isPlatform(post.platform)) {
    throw new PublishError(`This post is for "${post.platform}", which has no rules on file.`, false);
  }
  const adapter = adapterFor(post.platform);
  if (!adapter) {
    throw new PublishError(`There is no adapter for ${post.platform}.`, false);
  }

  const { data: integration, error: integrationError } = await sb
    .from("client_integrations")
    .select("credential_label, meta_page_id, ad_account_id")
    .eq("client_id", post.client_id)
    .eq("provider", adapter.provider)
    .maybeSingle();
  if (integrationError) {
    throw new PublishError(`Could not read the integration: ${integrationError.message}`, true);
  }
  const accountId = String(
    (integration as Record<string, string | null> | null)?.[adapter.accountColumn] ?? "",
  ).trim();
  if (!accountId) {
    throw new PublishError(
      `The ${adapter.provider} integration has no ${adapter.accountColumn.replace(/_/g, " ")}, so there is no account to post as.`,
      false,
    );
  }

  const { data: token, error: tokenError } = await sb.rpc("integration_secret", {
    p_client_id: post.client_id,
    p_provider: adapter.provider,
  });
  if (tokenError) throw new PublishError(`Could not read the credential: ${tokenError.message}`, true);
  if (!token) throw new PublishError(`No usable ${adapter.provider} credential for this client.`, false);

  const path = (post.media_path ?? "").trim();
  if (!path) throw new PublishError("The asset has no file to post.", false);
  const { data: signed, error: signError } = await sb.storage
    .from(MEDIA_BUCKET)
    .createSignedUrl(path, PROVIDER_MEDIA_FETCH_URL_TTL_SECONDS);
  const mediaUrl = signed?.signedUrl?.trim() ?? "";
  if (signError || !mediaUrl.startsWith("https://")) {
    // The platform fetches this URL itself, so anything it cannot reach is
    // a failure before the post rather than a broken post.
    throw new PublishError(`Could not sign a URL for ${path}.`, true);
  }

  // The frames, for a shape made of them. The queue has already refused a
  // carousel with an unsendable number of them (migration 220), so reaching
  // this with the wrong count means the frames changed between the claim and
  // now -- worth failing on rather than publishing a shorter carousel than
  // the one somebody approved.
  // Deliberately not coerceFormat, which falls back to 'single' when a format
  // and a media type disagree. That is right for ideation, where losing one
  // idea's shape beats losing the batch, and precisely wrong here: falling
  // back to 'single' is how a carousel goes out as one image, which is the
  // bug this whole path exists to make impossible.
  const format = post.content_format ?? "single";
  if (!isContentFormat(format)) {
    throw new PublishError(`This post is a "${format}", which has no rules on file.`, false);
  }
  let frames: PublishFrame[] | undefined;
  if (format === "carousel" || format === "story") {
    const paths = (post.frame_paths ?? []).map((value) => value.trim()).filter(Boolean);
    // A carousel is one post that must hold together, so two is its floor. A
    // story is a series of posts, and one of them is a story -- short, but
    // not wrong.
    const least = format === "carousel" ? MIN_FRAMES : 1;
    if (paths.length < least || paths.length > MAX_FRAMES) {
      throw new PublishError(
        `This ${format} has ${paths.length} frame${paths.length === 1 ? "" : "s"} to send, and a ${format} takes between ${least} and ${MAX_FRAMES}.`,
        false,
      );
    }
    const { data: signedFrames, error: frameError } = await sb.storage
      .from(MEDIA_BUCKET)
      .createSignedUrls(paths, PROVIDER_MEDIA_FETCH_URL_TTL_SECONDS);
    if (frameError || !signedFrames || signedFrames.length !== paths.length) {
      throw new PublishError(`Could not sign URLs for this ${format}'s ${paths.length} frames.`, true);
    }
    frames = paths.map((path, index) => {
      const url = signedFrames[index]?.signedUrl?.trim() ?? "";
      if (!url.startsWith("https://")) {
        // One unreachable frame is a failure before the post rather than a
        // carousel with a hole in it.
        throw new PublishError(`Could not sign a URL for frame ${index + 1} (${path}).`, true);
      }
      return { position: index + 1, mediaUrl: url };
    });
  }

  const words = compose(post.platform, {
    caption: post.caption,
    hashtags: post.hashtags,
    link_url: post.link_url,
    first_comment: post.first_comment,
  });

  return {
    postId: post.post_id,
    clientId: post.client_id,
    platform: post.platform,
    accessToken: String(token),
    accountId,
    mediaUrl,
    mediaKind: post.media_type === "video" ? "video" : "image",
    contentFormat: format,
    ...(frames ? { frames } : {}),
    caption: words.caption,
    firstComment: words.firstComment,
    altText: post.alt_text,
    linkUrl: post.link_url,
  };
}

/**
 * A story, which is not one publication.
 *
 * Neither platform has a multi-frame story container, so this sends each
 * frame as its own post and records it the moment it lands. That ordering is
 * the point. A story that gets three frames out and then meets an expired
 * token has three posts live on a client's account, and the only honest
 * record of that is three rows written as they happened -- not one row
 * written at the end, which would say either "published" (losing two) or
 * "failed" (while three are live, and a retry then sends them again).
 *
 * Because that record exists, a retry is safe and useful: it reads what has
 * already gone out and sends the rest.
 */
async function publishStory(
  sb: SupabaseClient,
  adapter: PublishAdapter,
  request: PublishRequest,
  post: ClaimedPost,
  jobId: string,
): Promise<PublishSuccess> {
  if (!adapter.publishFrame) {
    throw new PublishError(`The ${adapter.provider} adapter cannot send a story.`, false);
  }
  const frames = request.frames ?? [];
  if (frames.length === 0) throw new PublishError("This story has no frames to send.", false);

  // Read before send, so a failure here costs nothing. Not part of the claim:
  // this is the runner's own state rather than anything the adapter needs,
  // and it has to be re-read on every attempt by definition.
  const { data: done, error: doneError } = await sb
    .from("post_frame_publications")
    .select("position, external_id, external_url")
    .eq("post_id", request.postId);
  if (doneError) {
    throw new PublishError(`Could not read what has already gone out: ${doneError.message}`, true);
  }
  const already = new Map(
    (done ?? []).map((row) => [
      (row as { position: number }).position,
      row as { external_id: string; external_url: string | null },
    ]),
  );

  let first = already.get(1) ?? null;
  let sent = 0;
  for (const frame of frames) {
    if (already.has(frame.position)) continue;
    await requireOutgoingPublicationPrewrite(sb, post.post_id);
    await requireOrganicRoute(sb, post);
    const result = await adapter.publishFrame(request, frame);
    const { error: frameError } = await sb.rpc("record_frame_published", {
      p_post_id: request.postId,
      p_position: frame.position,
      p_external_id: result.externalId,
      p_external_url: result.externalUrl ?? null,
    } as never);
    // The frame is out. Failing to record it is worse than it sounds -- the
    // next attempt would send it again -- so this stops the story here rather
    // than carrying on and widening the gap between the account and the
    // record.
    if (frameError) {
      throw new Error(
        `Story frame ${frame.position} went out, but could not be recorded: ${frameError.message}`,
      );
    }
    sent += 1;
    first ??= { external_id: result.externalId, external_url: result.externalUrl ?? null };
    await appendEvent(
      sb,
      jobId,
      `${request.platform}: story frame ${frame.position} of ${frames.length} published.`,
      "info",
      { post_id: request.postId, position: frame.position, external_id: result.externalId },
    );
  }

  return {
    ok: true,
    externalId: first?.external_id ?? "",
    externalUrl: first?.external_url ?? null,
    detail:
      sent === frames.length
        ? `Published ${frames.length} story frames.`
        : `Published ${sent} story frames; ${frames.length - sent} were already out.`,
  };
}

export async function runPublisherJob(
  sb: SupabaseClient,
  runtime: RuntimeConfig,
  agent: AgentRow,
  job: AgentJobRow,
): Promise<JobResult> {
  if (!runtime.publishEnabled) {
    // Successfully nothing. See the header: a dry run that reports success
    // would have the database record a publication that did not happen.
    await appendEvent(sb, job.id, "Publishing is off in this runtime (PUBLISH_ENABLED). Nothing was claimed.", "info");
    return { ok: true, retryable: false };
  }

  const limit = Number((job.params as Record<string, unknown> | null)?.limit ?? DEFAULT_BATCH);
  const { data, error } = await sb.rpc("claim_posts_for_publishing", {
    p_limit: Number.isFinite(limit) && limit > 0 ? Math.min(Math.trunc(limit), 50) : DEFAULT_BATCH,
  } as never);
  if (error) throw new Error(`Could not claim posts to publish: ${error.message}`);

  const claimed = (data ?? []) as ClaimedPost[];
  if (claimed.length === 0) {
    await appendEvent(sb, job.id, "Nothing is due to go out.", "info");
    return { ok: true, retryable: false };
  }

  let published = 0;
  let failed = 0;

  for (const post of claimed) {
    try {
      const request = await prepare(sb, post);
      const adapter = adapterFor(post.platform)!;
      let result: PublishSuccess;
      if (request.contentFormat === "story") {
        result = await publishStory(sb, adapter, request, post, job.id);
      } else {
        await requireOutgoingPublicationPrewrite(sb, post.post_id);
        await requireOrganicRoute(sb, post);
        result = await adapter.publish(request);
      }

      const { error: recordError } = await sb.rpc("record_post_published", {
        p_post_id: post.post_id,
        p_external_id: result.externalId,
        p_external_url: result.externalUrl ?? null,
        p_bot: "publisher",
      } as never);
      // The post is out. If this write fails the row stays claimed and the
      // reaper will fail it, which is wrong but visible — and it says to go
      // and look at the account, which is exactly the right instruction.
      if (recordError) throw new Error(`Published, but could not record it: ${recordError.message}`);

      published += 1;

      // G10: record that the proof behind this post reached a public surface.
      // Deliberately after the publish is recorded and deliberately unable to
      // fail it: the post is already out, and losing a lineage row is worth a
      // warning rather than a retry that would publish it twice. The function
      // is idempotent and returns null for a post with no proof behind it.
      const { error: lineageError } = await sb.rpc("record_proof_placement_for_post_v6", {
        p_post_id: post.post_id,
      } as never);
      if (lineageError) {
        logger.warn("proof_lineage_not_recorded", {
          jobId: job.id, postId: post.post_id, error: lineageError.message,
        });
        await appendEvent(
          sb, job.id,
          `Published, but the proof behind it was not recorded: ${lineageError.message}`,
          "warn", { post_id: post.post_id },
        );
      }

      await appendEvent(sb, job.id, `${post.platform}: ${result.detail ?? "published"}.`, "info", {
        post_id: post.post_id,
        external_id: result.externalId,
        external_url: result.externalUrl ?? null,
      });
      logger.info("post_published", { jobId: job.id, postId: post.post_id, platform: post.platform });
    } catch (thrown) {
      failed += 1;
      const retryable = thrown instanceof PublishError ? thrown.retryable : false;
      const reason = safeProviderErrorMessage(thrown instanceof Error ? thrown.message : String(thrown));
      const { error: failError } = await sb.rpc("record_post_publish_failure", {
        p_post_id: post.post_id,
        p_reason: reason,
        p_retryable: retryable,
      } as never);
      if (failError) {
        logger.error("publish_failure_unrecorded", {
          jobId: job.id,
          postId: post.post_id,
          message: failError.message,
        });
      }
      await appendEvent(sb, job.id, `${post.platform}: ${reason}`, "warn", {
        post_id: post.post_id,
        retryable,
      });
    }
  }

  await appendEvent(
    sb,
    job.id,
    `${published} published, ${failed} not.`,
    failed > 0 ? "warn" : "info",
    { published, failed, claimed: claimed.length },
  );

  void agent;
  // The sweep did its job even when a post inside it did not: each failure
  // is recorded against its own post, and retrying the sweep would re-claim
  // only what is genuinely still due.
  return { ok: true, retryable: false };
}
