import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { GitHubApiError, GitHubSigningError } from "../../github/app-auth.js";
import { reconcileUncertainPage } from "./page-reconciler.js";

export async function runCampaignPageReconciliationJob(
  sb: SupabaseClient, config: RuntimeConfig, _agent: AgentRow, job: AgentJobRow,
): Promise<JobResult> {
  if (job.input_table !== "campaign_action_executions" || !job.input_id || !job.client_id) {
    return { ok: false, retryable: false,
      failureMessage: "One uncertain campaign page execution is required." };
  }
  try {
    const result = await reconcileUncertainPage(sb, config, job.input_id, job.client_id);
    if (result.status === "held") {
      await appendEvent(sb, job.id, result.reason ?? "GitHub page readback is held.", "warn");
      return { ok: false, retryable: false, hold: true,
        failureMessage: result.reason ?? "GitHub page readback is held." };
    }
    await appendEvent(sb, job.id,
      result.status === "matches_expected"
        ? "GitHub contains the expected page bytes at the checked ref; publication and intake remain unverified."
        : result.status === "missing"
          ? "GitHub has no page file at the checked ref; inspect the uncertain publish."
          : "GitHub page bytes differ from the expected version; inspect before any new publish.",
      "warn");
    return { ok: true, retryable: false };
  } catch (cause) {
    const reason = cause instanceof GitHubApiError ? cause.safeMessage
      : cause instanceof GitHubSigningError ? cause.safeMessage
        : "GitHub page readback failed; inspect the repository.";
    await appendEvent(sb, job.id, reason, "warn");
    return { ok: false, retryable: cause instanceof GitHubApiError
      && (cause.status === 429 || (cause.status ?? 0) >= 500), failureMessage: reason };
  }
}
