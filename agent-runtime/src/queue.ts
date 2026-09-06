// Thin wrapper over the claim/renew RPCs and the job state transitions.
// One responsibility per function.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface AgentJobRow {
  id: string;
  agent_key: string;
  client_id: string | null;
  input_table: string | null;
  input_id: string | null;
  /** Runner arguments not addressed by input_table/input_id, e.g. a surface and date window. */
  params: Record<string, unknown> | null;
  status: string;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_until: string | null;
}

export interface JobUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export async function claimNextJob(
  sb: SupabaseClient,
  leaseOwner: string,
  leaseSeconds: number,
  agentKeys: string[] | null = null,
): Promise<AgentJobRow | null> {
  const { data, error } = await sb.rpc("claim_agent_job", {
    p_lease_owner: leaseOwner,
    p_lease_seconds: leaseSeconds,
    p_agent_keys: agentKeys,
  });
  if (error) throw new Error(`claim_agent_job failed: ${error.message}`);

  // A composite-returning function that returns NULL comes back as an
  // object with every field null, NOT as bare null — confirmed live in
  // this project's own migration test. `data ?? null` does not catch it,
  // and a null-fielded "job" would reach markJobFailed with an invalid
  // uuid. The primary key is the only reliable "did I get a row" signal.
  const row = data as AgentJobRow | null;
  return row?.id ? row : null;
}

export async function markJobRunning(
  sb: SupabaseClient,
  jobId: string,
  leaseOwner: string,
): Promise<void> {
  const { error, count } = await sb
    .from("agent_jobs")
    // started_at is stamped per attempt, not once. Left at the first
    // attempt's value it makes "how long has this run been going"
    // unanswerable — a retry that had been running 30 seconds read as 12
    // minutes, which is long enough to look like the stall it had just
    // recovered from. created_at still carries when the job was queued.
    .update({ status: "running", started_at: new Date().toISOString() }, { count: "exact" })
    .eq("id", jobId)
    .eq("status", "claimed")
    .eq("lease_owner", leaseOwner);
  if (error) throw new Error(`Failed to mark job ${jobId} running: ${error.message}`);
  if (count !== 1) throw new Error(`Failed to mark job ${jobId} running: lease ownership lost.`);
}

export async function renewJobLease(
  sb: SupabaseClient,
  jobId: string,
  leaseOwner: string,
  leaseSeconds: number,
): Promise<boolean> {
  const { data, error } = await sb.rpc("renew_agent_job_lease", {
    p_job_id: jobId,
    p_lease_owner: leaseOwner,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw new Error(`Failed to renew lease on ${jobId}: ${error.message}`);
  return data === true;
}

function usagePatch(usage: JobUsage): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (usage.inputTokens !== undefined) patch.input_tokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) patch.output_tokens = usage.outputTokens;
  if (usage.costUsd !== undefined) patch.cost_usd = usage.costUsd;
  return patch;
}

export async function markJobCompleted(
  sb: SupabaseClient,
  jobId: string,
  leaseOwner: string,
  usage: JobUsage = {},
): Promise<void> {
  const { error, count } = await sb
    .from("agent_jobs")
    .update(
      {
        status: "completed",
        completed_at: new Date().toISOString(),
        lease_owner: null,
        lease_until: null,
        error: null,
        ...usagePatch(usage),
      },
      { count: "exact" },
    )
    .eq("id", jobId)
    .eq("lease_owner", leaseOwner);
  if (error) throw new Error(`Failed to complete job ${jobId}: ${error.message}`);
  if (count !== 1) throw new Error(`Failed to complete job ${jobId}: lease ownership lost.`);
}

export async function markJobFailed(
  sb: SupabaseClient,
  jobId: string,
  leaseOwner: string,
  attempts: number,
  maxAttempts: number,
  retryable: boolean,
  failureMessage: string,
  usage: JobUsage = {},
): Promise<void> {
  // A non-retryable failure is finished now; a retryable one is finished
  // only once the budget is spent. `terminal` carries that rather than the
  // attempt count, which used to be inflated to max to stop a re-claim and
  // in doing so reported three tries where there had been one.
  const terminal = !retryable || attempts >= maxAttempts;
  const { error, count } = await sb
    .from("agent_jobs")
    .update(
      {
        status: "failed",
        terminal,
        attempts,
        error: failureMessage.slice(0, 2000),
        completed_at: terminal ? new Date().toISOString() : null,
        lease_owner: null,
        lease_until: null,
        ...usagePatch(usage),
      },
      { count: "exact" },
    )
    .eq("id", jobId)
    .eq("lease_owner", leaseOwner);
  if (error) throw new Error(`Failed to fail job ${jobId}: ${error.message}`);
  if (count !== 1) throw new Error(`Failed to fail job ${jobId}: lease ownership lost.`);
}

export async function appendEvent(
  sb: SupabaseClient,
  jobId: string,
  description: string,
  level: "info" | "warn" | "error" = "info",
  payload: Record<string, unknown> = {},
): Promise<void> {
  await sb.from("agent_job_events").insert({
    job_id: jobId,
    description: description.slice(0, 2000),
    level,
    payload,
  });
}
