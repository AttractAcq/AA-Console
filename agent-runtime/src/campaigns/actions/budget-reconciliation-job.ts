import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { MetaWriteError } from "../../meta/ads.js";
import { reconcileUncertainBudget } from "./budget-reconciler.js";

export async function runCampaignBudgetReconciliationJob(
  sb: SupabaseClient, _config: RuntimeConfig, _agent: AgentRow, job: AgentJobRow,
): Promise<JobResult> {
  if (job.input_table !== "campaign_action_executions" || !job.input_id || !job.client_id) {
    return { ok: false, retryable: false,
      failureMessage: "One uncertain campaign budget execution is required." };
  }
  try {
    const result = await reconcileUncertainBudget(sb, job.input_id, job.client_id);
    if (result.status === "held") {
      await appendEvent(sb, job.id, result.reason ?? "Meta budget readback is held.", "warn");
      return { ok: false, retryable: false, hold: true,
        failureMessage: result.reason ?? "Meta budget readback is held." };
    }
    await appendEvent(sb, job.id,
      result.status === "matches_proposed"
        ? "Meta currently shows the proposed budget; this does not prove which action changed it."
        : result.status === "matches_prior"
          ? "Meta currently shows the prior budget; inspect the uncertain action."
          : "Meta shows another budget or currency; inspect the ad set before another request.",
      "warn");
    return { ok: true, retryable: false };
  } catch (cause) {
    const reason = cause instanceof MetaWriteError
      ? cause.message : "Meta budget readback failed; inspect the provider state.";
    await appendEvent(sb, job.id, reason, "warn");
    return { ok: false, retryable: cause instanceof MetaWriteError && cause.retryable,
      failureMessage: reason };
  }
}
