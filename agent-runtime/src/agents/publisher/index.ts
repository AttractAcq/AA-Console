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
import { PublishError, type PublishRequest } from "../../publishing/types.js";

const MEDIA_BUCKET = "client-media";
/** Long enough for Meta to fetch a reel, short enough not to be a public link. */
const SIGNED_URL_SECONDS = 60 * 60;
const DEFAULT_BATCH = 5;

export interface ClaimedPost {
  post_id: string;
  client_id: string;
  platform: string;
  provider: string;
  media_type: string | null;
  media_path: string | null;
  asset_id: string | null;
  caption: string | null;
  hashtags: string[] | null;
  alt_text: string | null;
  link_url: string | null;
  first_comment: string | null;
  scheduled_at: string;
  attempt: number;
}

/** Everything that can stop one post, before anything is sent. */
export async function prepare(
  sb: SupabaseClient,
  post: ClaimedPost,
): Promise<PublishRequest> {
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
    .createSignedUrl(path, SIGNED_URL_SECONDS);
  const mediaUrl = signed?.signedUrl?.trim() ?? "";
  if (signError || !mediaUrl.startsWith("https://")) {
    // The platform fetches this URL itself, so anything it cannot reach is
    // a failure before the post rather than a broken post.
    throw new PublishError(`Could not sign a URL for ${path}.`, true);
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
    caption: words.caption,
    firstComment: words.firstComment,
    altText: post.alt_text,
    linkUrl: post.link_url,
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
      const result = await adapter.publish(request);

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
      await appendEvent(sb, job.id, `${post.platform}: ${result.detail ?? "published"}.`, "info", {
        post_id: post.post_id,
        external_id: result.externalId,
        external_url: result.externalUrl ?? null,
      });
      logger.info("post_published", { jobId: job.id, postId: post.post_id, platform: post.platform });
    } catch (thrown) {
      failed += 1;
      const retryable = thrown instanceof PublishError ? thrown.retryable : false;
      const reason = thrown instanceof Error ? thrown.message : String(thrown);
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
