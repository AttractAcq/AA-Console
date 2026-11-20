/** One owner-requested, read-only Business Profile post observation. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentJobRow } from "../queue.js";
import type { JobResult } from "../orchestration/dispatch.js";
import { appendEvent } from "../queue.js";
import { readLocalPost } from "./google-business-post-read.js";
import { resolveProofSummary } from "./summary.js";

type Target = {
  placement_id: string; client_id: string; external_id: string;
  account_ref: string; payload_hash: string; media_required: boolean;
  artifact_version_id: string | null; proof_id: string | null; asset_id: string | null;
};

export async function runProofPlacementReadbackJob(
  sb: SupabaseClient, _runtime: unknown, _agent: unknown, job: AgentJobRow,
): Promise<JobResult> {
  if (job.input_table !== "proof_placements" || !job.input_id || !job.client_id) {
    return { ok: false, retryable: false, failureMessage: "Readback job lacks an exact placement and client." };
  }
  const { data, error } = await sb.rpc("proof_placement_readback_target_v8", {
    p_placement_id: job.input_id, p_client_id: job.client_id, p_job_id: job.id,
  } as never);
  if (error || !data) return { ok: false, retryable: false,
    failureMessage: "Provider readback target is no longer current." };
  const target = data as unknown as Target;
  const { data: integration, error: integrationError } = await sb.from("client_integrations")
    .select("status,credential_secret_id,token_expires_at")
    .eq("client_id", target.client_id).eq("provider", "google_business").maybeSingle();
  if (integrationError || !integration || !["active", "connected"].includes(integration.status)
    || !integration.credential_secret_id
    || (integration.token_expires_at && Date.parse(integration.token_expires_at) <= Date.now())) {
    return { ok: false, retryable: false, failureMessage: "Business Profile connection is not current." };
  }
  const { data: token, error: tokenError } = await sb.rpc("integration_secret", {
    p_client_id: target.client_id, p_provider: "google_business",
  });
  if (tokenError || !token) return { ok: false, retryable: false,
    failureMessage: "Business Profile credential is unavailable." };

  let summary: string;
  try { summary = await resolveProofSummary(sb, target); }
  catch { return { ok: false, retryable: false,
    failureMessage: "Current proof words could not be resolved." }; }
  const observation = await readLocalPost({
    accessToken: String(token), accountRef: target.account_ref,
    externalId: target.external_id, expectedSummary: summary,
    mediaRequired: target.media_required,
  });
  const { error: recordError } = await sb.rpc("record_proof_placement_provider_read_v8", {
    p_placement_id: target.placement_id, p_client_id: target.client_id,
    p_job_id: job.id, p_external_id: target.external_id,
    p_account_ref: target.account_ref, p_payload_hash: target.payload_hash,
    p_result: observation.status, p_provider_state: observation.providerState,
    p_observed_summary_sha256: observation.observedSummarySha256,
    p_provider_url: observation.providerUrl,
  } as never);
  if (recordError) return { ok: false, retryable: false,
    failureMessage: "Provider read completed, but its observation was not recorded." };
  await appendEvent(sb, job.id,
    `Business Profile readback: ${observation.status}. No post was sent.`, "info")
    .catch(() => undefined);
  return { ok: true, retryable: false };
}
