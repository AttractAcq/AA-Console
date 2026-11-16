import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import type { JobResult } from "../orchestration/dispatch.js";
import type { AgentRow } from "../orchestration/registry.js";
import type { AgentJobRow } from "../queue.js";
import { appendEvent } from "../queue.js";
import { GoogleReplyTransportError } from "./review-reply.js";
import { reconcileUncertainGoogleReply } from "./reply-reconciler.js";

export async function runGoogleReplyReconciliationJob(
  sb: SupabaseClient, _config: RuntimeConfig, _agent: AgentRow, job: AgentJobRow,
): Promise<JobResult> {
  if (job.input_table !== "google_reply_execution_attempts_v6"
    || !job.input_id || !job.client_id) {
    return { ok: false, retryable: false,
      failureMessage: "One uncertain client review reply attempt is required." };
  }
  try {
    const result = await reconcileUncertainGoogleReply(sb, job.input_id, job.client_id);
    if (result.status === "held") {
      await appendEvent(sb, job.id, result.reason ?? "Reply readback is held.", "warn");
      return { ok: false, retryable: false, hold: true,
        failureMessage: result.reason ?? "Reply readback is held." };
    }
    await appendEvent(sb, job.id,
      result.status === "matched"
        ? "Read-only Google reply check found the exact words with provider APPROVED state."
        : `Read-only Google reply check recorded ${result.status}; inspect the review before another proposal.`,
      result.status === "matched" ? "info" : "warn");
    return { ok: true, retryable: false };
  } catch (cause) {
    const reason = cause instanceof GoogleReplyTransportError
      ? cause.message : "Google reply readback failed; inspect the provider state.";
    await appendEvent(sb, job.id, reason, "warn");
    return { ok: false, retryable: cause instanceof GoogleReplyTransportError
      && cause.outcomeUncertain, failureMessage: reason };
  }
}
