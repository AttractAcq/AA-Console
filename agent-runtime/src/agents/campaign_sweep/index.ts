/**
 * Campaign sweep.
 *
 * The notes: "one run driving every asset to ready-to-distribute by calling the
 * factories, each process individually".
 *
 * THIS IS A COMPOSER, NOT AN ENGINE
 *
 * The engine exists and runs: `create_workflow_run` already takes a campaign,
 * `add_workflow_agent_step` takes dependencies and chains one step's output
 * into the next, and `reconcile_workflow_runs` drives them every fifteen
 * seconds with `agent_jobs` still the only execution queue. It carries ten runs
 * and a hundred and forty steps of real work.
 *
 * So this writes a run and its steps and stops. It calls no model and spends
 * nothing, which is why it has no provider loop.
 *
 * WHY THE RUNTIME AND NOT AN RPC
 *
 * Both engine functions require `auth.role() = 'service_role'`. A definer
 * function does not change `auth.role()` — it reads the caller's JWT claim — so
 * a browser cannot compose a run however the function is declared. That is a
 * deliberate property of the engine. `request_campaign_sweep_v6` therefore
 * checks the gate and queues this agent, which composes as service_role.
 *
 * WHAT IT DOES NOT TOUCH
 *
 * The landing page and the sales agent. `provision_campaign` already creates
 * those and enqueues their agents, is tested, has a button, and is gated by
 * 309. A sweep that added the same two steps would duplicate it, and this phase
 * has already removed three duplications of that exact shape.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { platformFor, sweepSteps } from "./plan.js";
import { plannedPieces } from "../campaign_plan/plan.js";
import { platformAllowsFormat } from "../../content/format.js";

/** How long a sweep's run has to finish before the engine calls it overdue. */
const DEADLINE_HOURS = 72;

export async function runCampaignSweepJob(
  sb: SupabaseClient,
  _config: RuntimeConfig,
  _agent: AgentRow,
  job: AgentJobRow,
  _deadlineAt: number,
): Promise<JobResult> {
  if (!job.client_id) {
    return { ok: false, retryable: false, failureMessage: "A sweep runs for one client." };
  }
  if (job.input_table !== "client_campaigns" || !job.input_id) {
    return {
      ok: false,
      retryable: false,
      failureMessage: "A sweep needs the campaign it is sweeping.",
    };
  }

  // Re-checked here rather than trusted from request time. 309 makes a plan
  // correctable, so the approval this sweep was asked for may have been
  // withdrawn in the minutes since.
  const { data: blocker, error: blockerError } = await sb.rpc("campaign_sweep_blocker_v6", {
    p_campaign_id: job.input_id,
  });
  if (blockerError) throw new Error(`Could not re-check the plan: ${blockerError.message}`);
  if (typeof blocker === "string" && blocker.length > 0) {
    // Not retryable: a withdrawn approval is a decision, not a transient fault,
    // and retrying would just re-read the same refusal.
    return { ok: false, retryable: false, failureMessage: blocker };
  }

  const { data: campaign, error: campaignError } = await sb
    .from("client_campaigns")
    .select("id, client_id, name, acquisition_mode, channels, content_count, organic_content_count, paid_content_count, content_pieces")
    .eq("id", job.input_id)
    .maybeSingle();
  if (campaignError) throw new Error(`Campaign lookup failed: ${campaignError.message}`);
  if (!campaign) {
    return { ok: false, retryable: false, failureMessage: "That campaign no longer exists." };
  }
  const c = campaign as {
    id: string; client_id: string; name: string; acquisition_mode: string;
    channels: string[] | null; content_count: number;
    organic_content_count: number; paid_content_count: number; content_pieces: unknown;
  };
  if (c.client_id !== job.client_id) {
    return { ok: false, retryable: false, failureMessage: "That campaign belongs to another client." };
  }

  const platform = platformFor(c.channels);
  if (platform === null) {
    // Composing a chain whose pieces have nowhere to go would fail at the end,
    // after paying for every idea and brief in it.
    return {
      ok: false,
      retryable: false,
      failureMessage: `This campaign's channels (${(c.channels ?? []).join(", ") || "none"}) name no platform a post can go to, so its content has no destination.`,
    };
  }

  // A legacy campaign has no route split, so its whole volume is one chain.
  // 308's columns are nought for legacy by design.
  const organicCount = c.acquisition_mode === "legacy" ? c.content_count : c.organic_content_count;
  const paidCount = c.acquisition_mode === "legacy" ? 0 : c.paid_content_count;
  let pieces;
  try {
    pieces = c.acquisition_mode === "legacy"
      ? Array.from({ length: c.content_count }, () => ({ acquisition_route: "organic" as const, media_type: "image" as const, content_format: "single" as const }))
      : plannedPieces(c.content_pieces, c.content_count, organicCount, paidCount);
  } catch (error) {
    return { ok: false, retryable: false, failureMessage: (error as Error).message };
  }
  if (pieces.some((piece) => !platformAllowsFormat(platform, piece.content_format))) {
    return { ok: false, retryable: false,
      failureMessage: `This plan includes a format ${platform} cannot publish. Review its piece mix.` };
  }
  const steps = sweepSteps({
    pieces,
    platform,
    campaignId: c.id,
  });
  if (steps.length === 0) {
    return {
      ok: false,
      retryable: false,
      failureMessage: "This plan divides into no pieces, so there is nothing to compose.",
    };
  }

  await appendEvent(
    sb,
    job.id,
    `Composing a sweep for ${c.name}: ${organicCount} organic and ${paidCount} paid piece${organicCount + paidCount === 1 ? "" : "s"} on ${platform}, ${steps.length} steps.`,
  );

  // The job id as the idempotency key, so a retried job composes the same run
  // rather than a second one. create_workflow_run returns the existing run on
  // conflict and raises idempotency_conflict if anything about it differs.
  const { data: run, error: runError } = await sb.rpc("create_workflow_run", {
    p_client_id: c.client_id,
    p_kind: "campaign_sweep",
    p_workflow_version: "v6.sweep.2",
    p_idempotency_key: job.id,
    p_input_snapshot: {
      campaign_id: c.id,
      organic_content_count: organicCount,
      paid_content_count: paidCount,
      content_pieces: pieces,
      target_platform: platform,
    },
    p_deadline_at: new Date(Date.now() + DEADLINE_HOURS * 3_600_000).toISOString(),
    p_campaign_id: c.id,
    p_root_request_id: job.id,
    p_created_by: null,
  });
  if (runError) throw new Error(`Could not create the sweep run: ${runError.message}`);
  const runId = (run as { id?: string } | null)?.id;
  if (!runId) throw new Error("The sweep run was created without an id.");

  // In order: add_workflow_agent_step refuses a dependency that does not exist
  // yet, so the chain has to be written front to back.
  for (const step of steps) {
    const { error } = await sb.rpc("add_workflow_agent_step", {
      p_run_id: runId,
      p_step_key: step.stepKey,
      p_dependencies: step.dependencies,
      p_agent_key: step.agentKey,
      p_input_table: step.inputTable,
      p_input_id: step.usesClientAsInput ? c.client_id : null,
      p_input_params: step.inputParams,
      p_input_from_step_key: step.inputFromStepKey,
    });
    if (error) throw new Error(`Could not add step ${step.stepKey}: ${error.message}`);
  }

  await appendEvent(
    sb,
    job.id,
    `Swept ${c.name} into ${steps.length} steps. The reconciler drives them from here; nothing distributes without its own approval.`,
    "info",
    { run_id: runId, steps: steps.length, organic: organicCount, paid: paidCount },
  );

  return { ok: true, retryable: false };
}
