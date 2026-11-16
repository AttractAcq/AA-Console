import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import type { JobResult } from "../orchestration/dispatch.js";
import type { AgentRow } from "../orchestration/registry.js";
import type { AgentJobRow } from "../queue.js";
import { appendEvent } from "../queue.js";
import { MetaProfileTransportError } from "./meta-page.js";
import { reconcileUncertainMetaPageField } from "./meta-profile-reconciler.js";

export async function runMetaProfileReconciliationJob(
  sb: SupabaseClient, _config: RuntimeConfig, _agent: AgentRow, job: AgentJobRow,
): Promise<JobResult> {
  if (job.input_table !== "meta_profile_execution_attempts_v6"
    || !job.input_id || !job.client_id) {
    return { ok: false, retryable: false,
      failureMessage: "One uncertain client Page attempt is required." };
  }
  try {
    const result = await reconcileUncertainMetaPageField(sb, job.input_id, job.client_id);
    if (result.status === "held") {
      await appendEvent(sb, job.id, result.reason ?? "Page readback is held.", "warn");
      return { ok: false, retryable: false, hold: true,
        failureMessage: result.reason ?? "Page readback is held." };
    }
    await appendEvent(sb, job.id,
      result.status === "matched"
        ? "Read-only Meta Page reconciliation matched the approved field."
        : "Read-only Meta Page reconciliation found a different field; inspect before any new proposal.",
      result.status === "matched" ? "info" : "warn");
    return { ok: true, retryable: false };
  } catch (cause) {
    const reason = cause instanceof MetaProfileTransportError
      ? cause.message : "Meta Page reconciliation failed; inspect the provider state.";
    await appendEvent(sb, job.id, reason, "warn");
    return { ok: false, retryable: cause instanceof MetaProfileTransportError && cause.retryable,
      failureMessage: reason };
  }
}
