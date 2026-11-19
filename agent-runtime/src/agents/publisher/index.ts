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
import { adapterFor } from "../../publishing/registry.js";
import { compose } from "../../publishing/caption.js";
import { safeProviderErrorMessage } from "../../storage/signed-url-policy.js";
import { verifyFrozenPublicationPackage } from "../../publishing/frozen-package.js";
import { assertMetaPublishPrerequisites,
  type PublishPreflightRequest } from "../../publishing/preflight.js";
import { readMetaPublication, type PublicationReadback } from "../../publishing/readback.js";
import { requireOrganicRoute } from "./organic-route.js";
import {
  PublishError,
  type PublishAdapter,
  type PublishFrame,
  type PublishRequest,
  type PublishSuccess,
} from "../../publishing/types.js";

const DEFAULT_BATCH = 5;
type Preflight = (input: PublishPreflightRequest) => Promise<void>;
type Readback = (request: PublishRequest, externalId: string) => Promise<PublicationReadback>;

async function recordProviderReadback(
  sb: SupabaseClient, jobId: string, request: PublishRequest,
  externalId: string, framePosition: number, readback: Readback,
): Promise<void> {
  let result: PublicationReadback;
  try { result = await readback(request, externalId); }
  catch { result = { status: "unavailable", observedAccountRef: null, providerUrl: null }; }
  try {
    const { error } = await sb.rpc("record_organic_provider_readback_v8", {
      p_post_id: request.postId, p_frame_position: framePosition,
      p_external_id: externalId, p_expected_account_ref: request.accountId,
      p_observed_account_ref: result.observedAccountRef,
      p_state: result.status, p_provider_url: result.providerUrl,
    } as never);
    if (error) throw new Error(error.message);
    await appendEvent(sb, jobId,
      `${request.platform}: provider account read-back ${result.status}.`,
      result.status === "verified" ? "info" : "warn",
      { post_id: request.postId, frame_position: framePosition, external_id: externalId });
  } catch (error) {
    // The public effect is already acknowledged. Losing a read-back row must
    // not put the post back in a publish retry queue.
    logger.warn("provider_readback_not_recorded", {
      jobId, postId: request.postId, framePosition,
      message: safeProviderErrorMessage(error instanceof Error ? error.message : "unknown"),
    });
  }
}

type PrewritePackage = { artifact_hash: string; manifest: Record<string, unknown> };

async function requireProviderPreflight(
  request: PublishRequest, expectedAppId: string | null, preflight: Preflight,
): Promise<void> {
  if (request.platform !== "instagram" && request.platform !== "facebook") {
    throw new PublishError("No publication preflight exists for this platform.", false);
  }
  await preflight({ platform: request.platform, accountId: request.accountId,
    accessToken: request.accessToken, expectedAppId });
}

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
  expectedArtifactHash?: string,
): Promise<PrewritePackage> {
  const { data, error } = await sb.rpc("require_organic_publication_prewrite_v6", {
    p_post_id: postId,
  } as never);
  const packet = data as { artifact_hash?: unknown; manifest?: unknown } | null;
  const artifactHash = packet?.artifact_hash;
  if (error || typeof artifactHash !== "string" || !/^[0-9a-f]{64}$/.test(artifactHash)
    || !packet?.manifest || typeof packet.manifest !== "object"
    || Array.isArray(packet.manifest) || expectedArtifactHash !== undefined
    && artifactHash !== expectedArtifactHash) {
    throw new PublishError(
      `Exact outgoing publication approval is unavailable: ${error?.message ?? "no approved package"}`,
      false,
    );
  }
  return { artifact_hash: artifactHash, manifest: packet.manifest as Record<string, unknown> };
}

/** Everything that can stop one post, before anything is sent. */
export async function prepare(
  sb: SupabaseClient,
  post: ClaimedPost,
): Promise<PublishRequest> {
  const approved = await requireOutgoingPublicationPrewrite(sb, post.post_id);
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

  const frozen = await verifyFrozenPublicationPackage(sb, approved, {
    clientId: post.client_id, postId: post.post_id,
    platform: post.platform, scheduledAt: post.scheduled_at, accountRef: accountId,
    provider: adapter.provider, contentFormat: post.content_format, mediaType: post.media_type,
  });
  const checkedCopy = compose(post.platform, {
    caption: frozen.caption, hashtags: null, link_url: null,
    first_comment: frozen.firstComment,
  });
  if (checkedCopy.caption !== frozen.caption
    || checkedCopy.firstComment !== frozen.firstComment) {
    throw new PublishError("Approved provider copy changed during validation.", false);
  }

  const { data: token, error: tokenError } = await sb.rpc("integration_secret", {
    p_client_id: post.client_id,
    p_provider: adapter.provider,
  });
  if (tokenError) throw new PublishError(`Could not read the credential: ${tokenError.message}`, true);
  if (!token) throw new PublishError(`No usable ${adapter.provider} credential for this client.`, false);

  const frames: PublishFrame[] | undefined = ["carousel", "story"].includes(frozen.contentFormat)
    ? frozen.mediaUrls.map((mediaUrl, index) => ({ position: index + 1, mediaUrl }))
    : undefined;

  return {
    postId: post.post_id,
    clientId: post.client_id,
    platform: post.platform,
    reviewedArtifactHash: frozen.artifactHash,
    accessToken: String(token),
    accountId,
    mediaUrl: frozen.mediaUrls[0]!,
    mediaKind: frozen.mediaType === "video" ? "video" : "image",
    contentFormat: frozen.contentFormat as PublishRequest["contentFormat"],
    ...(frames ? { frames } : {}),
    caption: frozen.caption,
    firstComment: frozen.firstComment,
    altText: frozen.altText,
    linkUrl: typeof (approved.manifest.copy as Record<string, unknown> | null)?.link_url === "string"
      ? (approved.manifest.copy as Record<string, string>).link_url : null,
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
  expectedAppId: string | null,
  preflight: Preflight,
  readback: Readback,
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
    await requireProviderPreflight(request, expectedAppId, preflight);
    await requireOutgoingPublicationPrewrite(sb, post.post_id, request.reviewedArtifactHash);
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
      throw new PublishError(
        `Story frame ${frame.position} was acknowledged, but its database record is uncertain: ${frameError.message}`,
        false, true,
      );
    }
    await recordProviderReadback(sb, jobId, request, result.externalId,
      frame.position, readback);
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
  _deadlineAt?: number,
  deps: { preflight?: Preflight; readback?: Readback } = {},
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
  const preflight = deps.preflight ?? assertMetaPublishPrerequisites;
  const readback = deps.readback ?? readMetaPublication;

  for (const post of claimed) {
    try {
      const request = await prepare(sb, post);
      const adapter = adapterFor(post.platform)!;
      let result: PublishSuccess;
      if (request.contentFormat === "story") {
        result = await publishStory(sb, adapter, request, post, job.id,
          runtime.metaAppId, preflight, readback);
      } else {
        await requireProviderPreflight(request, runtime.metaAppId, preflight);
        await requireOutgoingPublicationPrewrite(sb, post.post_id, request.reviewedArtifactHash);
        await requireOrganicRoute(sb, post);
        result = await adapter.publish(request);
      }

      const { error: recordError } = await sb.rpc("record_post_published", {
        p_post_id: post.post_id,
        p_external_id: result.externalId,
        p_external_url: result.externalUrl ?? null,
        p_bot: "publisher",
      } as never);
      // The provider has acknowledged a public effect. A failed or lost DB
      // response is uncertain, never a reason to queue another public write.
      if (recordError) throw new PublishError(
        `Provider acknowledged the post, but its database record is uncertain: ${recordError.message}`,
        false, true,
      );

      if (request.contentFormat !== "story") {
        await recordProviderReadback(sb, job.id, request, result.externalId, 0, readback);
      }

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
      if (thrown instanceof PublishError && thrown.uncertain) {
        const { error: uncertainError } = await sb.rpc("record_post_publish_uncertain_v7", {
          p_post_id: post.post_id,
          p_reason: reason,
        } as never);
        if (uncertainError) {
          logger.error("post_publish_uncertain_unrecorded", {
            jobId: job.id, postId: post.post_id, message: uncertainError.message,
          });
        }
        await appendEvent(sb, job.id,
          `${post.platform}: provider outcome uncertain. Inspect the account before another attempt.`,
          "warn", { post_id: post.post_id });
        continue;
      }
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
