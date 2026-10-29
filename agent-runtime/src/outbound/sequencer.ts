/**
 * The nurture sequencer — G11.
 *
 * Two database calls and almost no logic, which is the point. Deciding who
 * should receive what, and whether a sequence has stopped being relevant to
 * them, happens inside `enroll_due_leads_v6` and `advance_sequences_v6`
 * where the lead's current stage, its suppression and the sequence's
 * approval can all be read in one consistent snapshot.
 *
 * A worker that made those decisions would be reading a lead's stage, then
 * queueing a message, with a gap in between — and that gap is exactly when
 * somebody books a call.
 *
 * ENROL BEFORE ADVANCING
 *
 * In that order deliberately: a lead enrolled this tick with a zero-hour
 * first step then receives it in the same tick, rather than waiting fifteen
 * minutes for the next one.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../config.js";
import type { AgentRow } from "../orchestration/registry.js";
import type { JobResult } from "../orchestration/dispatch.js";
import type { AgentJobRow } from "../queue.js";
import { appendEvent } from "../queue.js";
import { logger } from "../logging/logger.js";

const DEFAULT_LIMIT = 50;

export async function runNurtureSequencerJob(
  sb: SupabaseClient,
  config: RuntimeConfig,
  _agent: AgentRow,
  job: AgentJobRow,
): Promise<JobResult> {
  // The same switch the courier reads. A sequence that enrolled people while
  // nothing could send would build a backlog that all leaves at once on the
  // day somebody turns sending on.
  if (!config.outboundMessagingEnabled) {
    await appendEvent(
      sb,
      job.id,
      "Outbound messaging is off in this runtime (OUTBOUND_MESSAGING_ENABLED). No lead was enrolled and no step was queued.",
      "info",
    );
    return { ok: true, retryable: false };
  }

  const limit = Number((job.params as { limit?: number } | null)?.limit ?? DEFAULT_LIMIT);

  const { data: enrolled, error: enrolError } = await sb.rpc("enroll_due_leads_v6", {
    p_limit: limit,
  } as never);
  if (enrolError) {
    return {
      ok: false,
      retryable: true,
      failureMessage: `Could not enrol leads: ${enrolError.message}`,
    };
  }

  const { data: advanced, error: advanceError } = await sb.rpc("advance_sequences_v6", {
    p_limit: limit,
  } as never);
  if (advanceError) {
    // The enrolments above stand: they are idempotent per lead and sequence,
    // so a retry re-enrols nobody and simply advances what is due.
    return {
      ok: false,
      retryable: true,
      failureMessage: `Enrolled ${Number(enrolled ?? 0)}, but could not advance: ${advanceError.message}`,
    };
  }

  const enrolledCount = Number(enrolled ?? 0);
  const advancedCount = Number(advanced ?? 0);

  await appendEvent(
    sb,
    job.id,
    `${enrolledCount} lead(s) enrolled, ${advancedCount} step(s) queued. The courier sends them.`,
    "info",
  );
  logger.info("nurture_sequencer_ran", {
    jobId: job.id, enrolled: enrolledCount, advanced: advancedCount,
  });
  return { ok: true, retryable: false };
}
