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
    .update({ status: "running" }, { count: "exact" })
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
  // Burning the attempt budget is what makes a non-retryable failure
  // terminal — claim_agent_job only re-picks failed jobs under the cap.
  const terminal = !retryable || attempts >= maxAttempts;
  const { error, count } = await sb
    .from("agent_jobs")
    .update(
      {
        status: "failed",
        attempts: terminal ? maxAttempts : attempts,
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
