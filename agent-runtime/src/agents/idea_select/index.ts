/**
 * Choosing between the candidates ideation produced for a slot.
 *
 * There is no model here, and that is the design rather than an omission.
 * The build plan allows "an agent or a scorer", and every criterion it lists
 * — novelty against the client's archive, proof on file, whether the idea
 * arrived complete — is measurable. select_idea_for_slot (migration 152)
 * does the measuring in one statement; this runner exists so the choice
 * appears in the job queue and on the slot timeline like every other step,
 * rather than happening invisibly inside the tick.
 *
 * So it costs a round trip and no tokens. If performance priors arrive with
 * M4 and the ranking stops being arithmetic, this is where a model would go.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { loadSlot } from "../../engine/slot.js";
import { logger } from "../../logging/logger.js";

interface Decision {
  idea_id: string | null;
  score: number | string | null;
  reasons: unknown;
  considered: unknown;
}

export async function runIdeaSelectJob(
  sb: SupabaseClient,
  _runtime: RuntimeConfig,
  _agent: AgentRow,
  job: AgentJobRow,
): Promise<JobResult> {
  let slot;
  try {
    slot = await loadSlot(sb, job);
  } catch (error) {
    return {
      ok: false,
      retryable: false,
      failureMessage: error instanceof Error ? error.message : String(error),
    };
  }

  if (!slot) {
    // Nothing else queues this agent, so a job without a slot is a job that
    // should not exist rather than a hand run to be accommodated.
    return {
      ok: false,
      retryable: false,
      failureMessage: "The idea selector only runs for a slot, and this job has none.",
    };
  }

  const { data, error } = await sb.rpc("select_idea_for_slot", { p_slot_id: slot.id } as never);

  if (error) {
    // Nothing to choose between is a real state, not a fault: ideation may
    // have produced nothing usable. Retrying would re-run a selection over
    // the same empty set.
    const noCandidates = /no undecided ideas/i.test(error.message);
    return {
      ok: false,
      retryable: !noCandidates,
      failureMessage: error.message,
    };
  }

  const decision = (Array.isArray(data) ? data[0] : data) as Decision | null;
  const reasons = Array.isArray(decision?.reasons) ? (decision.reasons as string[]) : [];
  const passedOver = Array.isArray(decision?.considered) ? decision.considered.length : 0;

  await appendEvent(
    sb,
    job.id,
    `Chose 1 of ${passedOver + 1} candidates, scoring ${decision?.score ?? "?"}/100.`,
    "info",
    { slot_id: slot.id, idea_id: decision?.idea_id, reasons, passed_over: passedOver },
  );
  logger.info("idea_selected", { jobId: job.id, slotId: slot.id, ideaId: decision?.idea_id });

  // select_idea_for_slot already moved the slot to idea_selected, as part of
  // the same statement that approved the idea. Doing it again here would be
  // a second answer to a question already settled, and advance_slot would
  // rightly refuse it.
  return { ok: true, retryable: false };
}
