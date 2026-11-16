import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import type { AgentRow } from "../orchestration/registry.js";
import type { JobResult } from "../orchestration/dispatch.js";
import type { AgentJobRow } from "../queue.js";
import { appendEvent } from "../queue.js";
import { sendApprovedGoogleReply } from "./reply-sender.js";

export async function runGoogleReplySenderJob(
  sb: SupabaseClient, config: RuntimeConfig, _agent: AgentRow, job: AgentJobRow,
): Promise<JobResult> {
  if (!config.googleReviewReplyEnabled) {
    const reason = "Google review replies are held by GOOGLE_REVIEW_REPLY_ENABLED. No provider request was made.";
    await appendEvent(sb, job.id, reason, "warn");
    return { ok: false, retryable: false, hold: true, failureMessage: reason };
  }
  if (job.input_table !== "google_review_replies" || !job.input_id || !job.client_id) {
    return { ok: false, retryable: false, failureMessage: "A specific client Google reply is required." };
  }
  const result = await sendApprovedGoogleReply(sb, job.input_id);
  if (result.status === "held") {
    await appendEvent(sb, job.id, result.reason, "warn");
    return { ok: false, retryable: false, hold: true, failureMessage: result.reason };
  }
  if (result.status === "confirmed") {
    await appendEvent(sb, job.id,
      `Google reply provider readback confirmed for attempt ${result.attemptId}.`, "info",
      { attempt_id: result.attemptId, provider_state: result.providerState });
    return { ok: true, retryable: false };
  }
  await appendEvent(sb, job.id,
    `Google reply attempt ${result.attemptId} is ${result.status}: ${result.reason}`, "warn",
    { attempt_id: result.attemptId, outcome: result.status });
  return { ok: false, retryable: false, failureMessage: result.reason };
}
