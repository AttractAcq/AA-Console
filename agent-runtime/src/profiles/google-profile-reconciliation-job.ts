import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import type { JobResult } from "../orchestration/dispatch.js";
import type { AgentRow } from "../orchestration/registry.js";
import type { AgentJobRow } from "../queue.js";
import { appendEvent } from "../queue.js";
import { PlacementTransportError } from "../proof-distribution/google-business.js";
import { reconcileUncertainGoogleProfileField } from "./google-profile-reconciler.js";

export async function runGoogleProfileReconciliationJob(
  sb: SupabaseClient, _config: RuntimeConfig, _agent: AgentRow, job: AgentJobRow,
): Promise<JobResult> {
  if (job.input_table !== "google_profile_execution_attempts_v6"
    || !job.input_id || !job.client_id) {
    return { ok: false, retryable: false,
      failureMessage: "One uncertain client location attempt is required." };
  }
  try {
    const result = await reconcileUncertainGoogleProfileField(sb, job.input_id, job.client_id);
    if (result.status === "held") {
      await appendEvent(sb, job.id, result.reason ?? "Location readback is held.", "warn");
      return { ok: false, retryable: false, hold: true,
        failureMessage: result.reason ?? "Location readback is held." };
    }
    await appendEvent(sb, job.id,
      result.status === "matched"
        ? "Read-only Google location reconciliation matched the approved merchant field."
        : "Read-only Google location reconciliation found a different field; inspect before any new proposal.",
      result.status === "matched" ? "info" : "warn");
    return { ok: true, retryable: false };
  } catch (cause) {
    const reason = cause instanceof PlacementTransportError
      ? cause.message : "Google location reconciliation failed; inspect the provider state.";
    await appendEvent(sb, job.id, reason, "warn");
    return { ok: false, retryable: cause instanceof PlacementTransportError && cause.retryable,
      failureMessage: reason };
  }
}
