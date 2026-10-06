/**
 * What an agent needs to know about the slot it was given.
 *
 * The engine queues every job with `{ slot_id }` in params and
 * `input_table = 'content_slots'`. From M3.5 onwards each agent in the
 * pipeline has to read that, work to the slot's constraints, and report back
 * through advance_slot. The reading is the same every time, so it lives here
 * rather than being written out once per agent and drifting.
 *
 * An agent run by a person has no slot, and that is not an error: the same
 * agents still do their original job when someone presses the button. So
 * every function here returns null rather than throwing when there is no
 * slot, and the agents branch on that.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AgentJobRow } from "../queue.js";
import type { ContentFormat } from "../content/format.js";

/** How many ideas a slot-driven run asks for. */
export const SLOT_IDEA_COUNT = 4;

export interface SlotContext {
  id: string;
  client_id: string;
  stage: string;
  format: ContentFormat;
  platform: string;
  scheduled_at: string;
  pillar_id: string | null;
  idea_id: string | null;
  brief_id: string | null;
  asset_id: string | null;
  attempts: number;
}

/**
 * The slot id this job was queued for, or null.
 *
 * Read from params rather than input_id. Both carry it today, but params is
 * what the tick sets deliberately and input_id is also used for the row an
 * agent was pointed at by a person, so params is the one that means "the
 * engine sent this".
 */
export function slotIdOf(job: AgentJobRow): string | null {
  const fromParams = (job.params as { slot_id?: unknown } | null)?.slot_id;
  return typeof fromParams === "string" && fromParams.length > 0 ? fromParams : null;
}

/** Whether the engine queued this job, as opposed to a person. */
export function isEngineJob(job: AgentJobRow): boolean {
  return slotIdOf(job) !== null;
}

/**
 * The slot, or null when this job is not a slot job.
 *
 * Throws only when the job says it has a slot and the slot is not there,
 * because that is a broken job rather than a hand-run one: carrying on
 * without the constraints the slot carries would produce work nobody asked
 * for and file it as though they had.
 */
export async function loadSlot(sb: SupabaseClient, job: AgentJobRow): Promise<SlotContext | null> {
  const slotId = slotIdOf(job);
  if (!slotId) return null;

  const { data, error } = await sb
    .from("content_slots")
    .select("id, client_id, stage, format, platform, scheduled_at, pillar_id, idea_id, brief_id, asset_id, attempts")
    .eq("id", slotId)
    .maybeSingle();

  if (error) throw new Error(`Could not read slot ${slotId}: ${error.message}`);
  if (!data) throw new Error(`This job names slot ${slotId}, which no longer exists.`);

  const slot = data as unknown as SlotContext;
  if (job.client_id && slot.client_id !== job.client_id) {
    // Belt and braces. A job pointed at another client's slot would write
    // that client's work into this one's bank.
    throw new Error(`Slot ${slotId} belongs to a different client than this job.`);
  }
  return slot;
}

export type SlotActor = "engine" | "agent" | "human" | "policy";

/**
 * Report a slot's progress.
 *
 * Every agent calls this instead of updating the row: advance_slot is the
 * only thing permitted to write stage (migration 147), and it is what writes
 * the event the timeline is built from.
 */
export async function advanceSlot(
  sb: SupabaseClient,
  slotId: string,
  toStage: string,
  options: {
    actor?: SlotActor;
    note?: string;
    agentKey?: string;
    jobId?: string;
    costUsd?: number;
    ideaId?: string;
    briefId?: string;
    assetId?: string;
    scheduledPostId?: string;
    blockedReason?: string;
  } = {},
): Promise<void> {
  const { error } = await sb.rpc("advance_slot", {
    p_slot_id: slotId,
    p_to_stage: toStage,
    p_actor: options.actor ?? "agent",
    p_note: options.note ?? undefined,
    p_agent_key: options.agentKey ?? undefined,
    p_job_id: options.jobId ?? undefined,
    p_cost_usd: options.costUsd ?? undefined,
    p_idea_id: options.ideaId ?? undefined,
    p_brief_id: options.briefId ?? undefined,
    p_asset_id: options.assetId ?? undefined,
    p_scheduled_post_id: options.scheduledPostId ?? undefined,
    p_blocked_reason: options.blockedReason ?? undefined,
  } as never);
  if (error) throw new Error(`Could not move slot ${slotId} to ${toStage}: ${error.message}`);
}

/**
 * Tell the slot the work failed, without letting that failure mask the real
 * one.
 *
 * An agent that throws while reporting a failure replaces a message about
 * what actually went wrong with a message about the reporting, which is the
 * less useful of the two. So this swallows its own error and leaves the
 * original to be raised by the caller.
 */
export async function failSlot(
  sb: SupabaseClient,
  slotId: string,
  reason: string,
  options: { agentKey?: string; jobId?: string } = {},
): Promise<void> {
  try {
    await advanceSlot(sb, slotId, "failed", { ...options, note: reason, blockedReason: reason });
  } catch {
    // Deliberately quiet. See above.
  }
}
