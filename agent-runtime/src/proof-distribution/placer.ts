/**
 * The proof placement sweep.
 *
 * Migration 218 built the whole placement lifecycle and left it with nothing
 * calling it, so that the first adapter would be "a transport and not a
 * transport plus a lifecycle". This is that caller.
 *
 * FOUR SWITCHES, AND THIS IS ONLY THE FOURTH
 *
 * PROOF_PUBLISH_ENABLED here, proof_publishing_enabled per client,
 * client_proof_destinations.enabled per destination, and a human decision on
 * the placement itself. `proof_placement_due` evaluates all of them plus the
 * rights position, and `claim_proof_placements` claims only rows it has
 * cleared -- inside the same locked statement, so the answer cannot go stale
 * between the question and the claim.
 *
 * THE CHECK THIS FILE ADDS ON TOP
 *
 * The hash. The view compares the placement's stored hash with the approved
 * one, which catches an approval given for different words. It cannot catch
 * the stored hash itself having drifted from what the payload would hash to
 * now -- a re-cleared proof with new evidence text, an artifact edited
 * underneath. So this recomputes the hash from the live rows immediately
 * before the write, and refuses to post when it differs. That is the whole
 * meaning of "the exact version a person approved".
 *
 * ONE PLACEMENT'S FAILURE IS ITS OWN, and a failure that did not obviously
 * happen before the write is never retryable: a retried review reply posts
 * twice on a client's public profile and there is no unsending it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../config.js";
import type { AgentRow } from "../orchestration/registry.js";
import type { JobResult } from "../orchestration/dispatch.js";
import type { AgentJobRow } from "../queue.js";
import { appendEvent } from "../queue.js";
import { logger } from "../logging/logger.js";
import { createLocalPost, PlacementTransportError } from "./google-business.js";
import { PROVIDER_MEDIA_FETCH_URL_TTL_SECONDS, safeProviderErrorMessage } from "../storage/signed-url-policy.js";

const MEDIA_BUCKET = "client-media";
const DEFAULT_BATCH = 5;

export interface ClaimedPlacement {
  placement_id: string;
  client_id: string;
  destination_key: string;
  provider: string | null;
  artifact_version_id: string | null;
  proof_id: string | null;
  asset_id: string | null;
  payload_hash: string;
  account_ref: string | null;
  attempt: number;
}

/** The exact words and media a placement carries, resolved from live rows. */
export interface ResolvedPayload {
  readonly summary: string;
  readonly mediaUrl: string | null;
}

/**
 * What a placement says, read now rather than when it was drafted.
 *
 * Reading it live is the point: it is what makes the hash check below mean
 * something. A snapshot taken at draft time would hash to itself forever.
 */
export async function resolvePayload(
  sb: SupabaseClient,
  placement: ClaimedPlacement,
): Promise<ResolvedPayload> {
  if (placement.artifact_version_id) {
    const { data, error } = await sb
      .from("proof_artifact_versions")
      .select("content, supported_claim")
      .eq("id", placement.artifact_version_id)
      .maybeSingle();
    if (error) throw new PlacementTransportError(`Could not read the artifact: ${error.message}`, true);
    const content = (data as { content?: string } | null)?.content?.trim() ?? "";
    if (!content) throw new PlacementTransportError("That artifact has no content to post.", false);
    return { summary: content, mediaUrl: null };
  }

  if (placement.proof_id) {
    const { data, error } = await sb
      .from("client_proof_assets")
      .select("claim, evidence, body")
      .eq("id", placement.proof_id)
      .maybeSingle();
    if (error) throw new PlacementTransportError(`Could not read the proof: ${error.message}`, true);
    const row = (data ?? {}) as { claim?: string; evidence?: string; body?: string };
    // The claim and the evidence behind it, in that order. Never one without
    // the other: a claim on a public profile with no evidence under it is
    // the thing this system is built not to produce.
    const summary = [row.claim?.trim(), (row.evidence ?? row.body)?.trim()]
      .filter(Boolean)
      .join("\n\n");
    if (!summary) throw new PlacementTransportError("That proof has no words to post.", false);
    return { summary, mediaUrl: null };
  }

  const { data, error } = await sb
    .from("client_media_assets")
    .select("render_path, storage_path, caption")
    .eq("id", placement.asset_id ?? "")
    .maybeSingle();
  if (error) throw new PlacementTransportError(`Could not read the asset: ${error.message}`, true);
  const row = (data ?? {}) as { render_path?: string; storage_path?: string; caption?: string };
  const path = (row.render_path ?? row.storage_path ?? "").trim();
  if (!path) throw new PlacementTransportError("That asset has no file to post.", false);

  const { data: signed, error: signError } = await sb.storage
    .from(MEDIA_BUCKET)
    .createSignedUrl(path, PROVIDER_MEDIA_FETCH_URL_TTL_SECONDS);
  const mediaUrl = signed?.signedUrl?.trim() ?? "";
  if (signError || !mediaUrl.startsWith("https://")) {
    // The destination fetches this URL itself, so anything it cannot reach
    // is a failure before the post rather than a broken post.
    throw new PlacementTransportError(`Could not sign a URL for ${path}.`, true);
  }
  return { summary: row.caption?.trim() || "", mediaUrl };
}

/**
 * The hash check, against the live rows.
 *
 * Asks the database for the hash the payload would have now, using the same
 * function that produced the stored one, and refuses when they differ.
 */
export async function assertPayloadUnchanged(
  sb: SupabaseClient,
  placement: ClaimedPlacement,
): Promise<void> {
  const { data, error } = await sb.rpc("proof_placement_payload_hash_v6", {
    p_artifact_version_id: placement.artifact_version_id,
    p_proof_id: placement.proof_id,
    p_asset_id: placement.asset_id,
    p_destination_key: placement.destination_key,
  } as never);
  if (error) {
    throw new PlacementTransportError(`Could not re-check the approved version: ${error.message}`, true);
  }
  const current = String(data ?? "");
  if (!current) {
    throw new PlacementTransportError(
      "The payload could not be hashed, so there is no way to tell whether it is what somebody approved.",
      false,
    );
  }
  if (current !== placement.payload_hash) {
    throw new PlacementTransportError(
      "The payload has changed since it was approved. Draft a new placement rather than posting this one.",
      false,
    );
  }
}

/** One placement, all the way to an external id. */
export async function place(
  sb: SupabaseClient,
  placement: ClaimedPlacement,
): Promise<{ externalId: string; externalUrl: string | null }> {
  await assertPayloadUnchanged(sb, placement);

  if (placement.provider !== "google_business") {
    // The sweep should never have been handed this: the destination table
    // decides what is claimable. Loud rather than silent, because it means
    // a destination was marked supported with no transport behind it.
    throw new PlacementTransportError(
      `There is no transport in this runtime for ${placement.destination_key}.`,
      false,
    );
  }

  const accountRef = (placement.account_ref ?? "").trim();
  if (!accountRef) {
    throw new PlacementTransportError(
      "This client has no Business Profile location recorded for proof placement.",
      false,
    );
  }

  const { data: token, error: tokenError } = await sb.rpc("integration_secret", {
    p_client_id: placement.client_id,
    p_provider: "google_business",
  });
  if (tokenError) {
    throw new PlacementTransportError(`Could not read the credential: ${tokenError.message}`, true);
  }
  if (!token) {
    throw new PlacementTransportError("No usable google_business credential for this client.", false);
  }

  const payload = await resolvePayload(sb, placement);
  return createLocalPost({
    accessToken: String(token),
    accountRef,
    summary: payload.summary,
    mediaUrl: payload.mediaUrl,
  });
}

export async function runProofPlacerJob(
  sb: SupabaseClient,
  runtime: RuntimeConfig,
  agent: AgentRow,
  job: AgentJobRow,
): Promise<JobResult> {
  if (!runtime.proofPublishEnabled) {
    // Successfully nothing. See the publisher's header: a dry run reporting
    // success would have the database record a placement that never
    // happened, and a placement record is what retraction depends on.
    await appendEvent(
      sb,
      job.id,
      "Proof placement is off in this runtime (PROOF_PUBLISH_ENABLED). Nothing was claimed.",
      "info",
    );
    return { ok: true, retryable: false };
  }

  const asked = Number((job.params as Record<string, unknown> | null)?.limit ?? DEFAULT_BATCH);
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.trunc(asked), 25) : DEFAULT_BATCH;
  const { data, error } = await sb.rpc("claim_proof_placements", { p_limit: limit } as never);
  if (error) throw new Error(`Could not claim placements: ${error.message}`);

  const claimed = (data ?? []) as ClaimedPlacement[];
  if (claimed.length === 0) {
    await appendEvent(sb, job.id, "Nothing is waiting to be placed.", "info");
    return { ok: true, retryable: false };
  }

  let placed = 0;
  let failed = 0;

  for (const placement of claimed) {
    try {
      const result = await place(sb, placement);
      const { error: recordError } = await sb.rpc("record_proof_placed", {
        p_placement_id: placement.placement_id,
        p_external_id: result.externalId,
        p_external_url: result.externalUrl,
      } as never);
      // It is out there. A failure to record leaves the row claimed for the
      // reaper, which abandons it and says to go and look at the profile --
      // wrong, but visible, and the right instruction.
      if (recordError) throw new Error(`Placed, but could not record it: ${recordError.message}`);

      placed += 1;
      await appendEvent(sb, job.id, `${placement.destination_key}: placed.`, "info", {
        placement_id: placement.placement_id,
        external_id: result.externalId,
        external_url: result.externalUrl,
      });
      logger.info("proof_placed", {
        jobId: job.id,
        placementId: placement.placement_id,
        destination: placement.destination_key,
      });
    } catch (thrown) {
      failed += 1;
      const retryable = thrown instanceof PlacementTransportError ? thrown.retryable : false;
      const reason = safeProviderErrorMessage(thrown instanceof Error ? thrown.message : String(thrown));
      const { error: failError } = await sb.rpc("record_proof_placement_failure", {
        p_placement_id: placement.placement_id,
        p_reason: reason,
        p_retryable: retryable,
      } as never);
      if (failError) {
        logger.error("proof_placement_failure_unrecorded", {
          jobId: job.id,
          placementId: placement.placement_id,
          message: failError.message,
        });
      }
      await appendEvent(sb, job.id, `${placement.destination_key}: ${reason}`, "warn", {
        placement_id: placement.placement_id,
        retryable,
      });
    }
  }

  await appendEvent(sb, job.id, `${placed} placed, ${failed} not.`, failed > 0 ? "warn" : "info", {
    placed,
    failed,
    claimed: claimed.length,
  });

  void agent;
  return { ok: true, retryable: false };
}
