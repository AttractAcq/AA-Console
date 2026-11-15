import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import type { AgentRow } from "../orchestration/registry.js";
import type { JobResult } from "../orchestration/dispatch.js";
import type { AgentJobRow } from "../queue.js";
import { appendEvent } from "../queue.js";
import { writeApprovedMetaPageField } from "./meta-profile-writer.js";

export async function runMetaProfileFieldJob(
  sb: SupabaseClient, config: RuntimeConfig, _agent: AgentRow, job: AgentJobRow,
): Promise<JobResult> {
  if (!config.metaProfileFieldWriteEnabled) {
    const reason = "Meta Page field writes are held by META_PROFILE_FIELD_WRITE_ENABLED. No provider request was made.";
    await appendEvent(sb, job.id, reason, "warn");
    return { ok: false, retryable: false, hold: true, failureMessage: reason };
  }
  if (job.input_table !== "meta_profile_changes" || !job.input_id || !job.client_id) {
    return { ok: false, retryable: false,
      failureMessage: "One specific client Meta Page proposal is required." };
  }
  const result = await writeApprovedMetaPageField(sb, job.input_id, job.client_id);
  if (result.status === "held") {
    await appendEvent(sb, job.id, result.reason, "warn");
    return { ok: false, retryable: false, hold: true, failureMessage: result.reason };
  }
  if (result.status === "confirmed") {
    await appendEvent(sb, job.id,
      `Meta Page field readback confirmed for attempt ${result.attemptId}.`, "info",
      { attempt_id: result.attemptId, provider_ref: result.providerRef });
    return { ok: true, retryable: false };
  }
  await appendEvent(sb, job.id,
    `Meta Page field attempt ${result.attemptId} is ${result.status}: ${result.reason}`, "warn",
    { attempt_id: result.attemptId, outcome: result.status });
  return { ok: false, retryable: false, failureMessage: result.reason };
}
