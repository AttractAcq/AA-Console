/**
 * The join between the Higgsfield builder and the editor.
 *
 * video_build ends with a clip per shot on client_media_frames.clip_path.
 * This module turns those rows, plus the brief that planned them, into what
 * plan.ts and edl.ts need. It is the whole contract between the two agents,
 * in one file, so a change to either shape fails here rather than halfway
 * through a render.
 *
 * It reads rows and returns values. No Supabase client, no network, no
 * ffmpeg: the caller fetches and this decides.
 *
 * Why readiness is a gate and not a filter. Editing four shots of a
 * five-shot reel produces a reel that looks finished and is not, and the
 * missing shot is the one nobody notices. A reel is edited whole or not yet.
 */

import { parseStoredShotPlan } from "../brief/shots.js";
import type { EdlContext } from "./edl.js";

/** Shot order comes from position, which video_build writes from the plan. */
export interface FrameRowForEdit {
  id: string;
  position: number;
  beat: string | null;
  duration_sec: number | string | null;
  shot_source_kind: string | null;
  clip_path: string | null;
  provider_job_id: string | null;
  /** The line the still already shows. Set when the artwork has text burned in. */
  caption: string | null;
}

export interface BriefForEdit {
  id: string;
  title: string | null;
  media_type: string | null;
  content_format: string | null;
  format_code: string | null;
  frame_plan: string[] | null;
  hook: string | null;
  script: string | null;
  call_to_action: string | null;
  proof: string | null;
  channel_intent: string | null;
}

export interface EditShot {
  shot: number;
  frameId: string;
  beat: string;
  /** From the plan. The real length is probed from the clip before rendering. */
  plannedDurationSec: number;
  shotSourceKind: string;
  clipPath: string;
  /**
   * The line this shot already shows on screen, or empty.
   *
   * Higgsfield burns the script line into the still, so the frame arrives
   * with its own typography in it. A drawtext caption over the same shot is
   * a second piece of text in a second typeface, and on AA-0121 all three
   * landed on top of the artwork. Captions are suppressed where this is set.
   */
  burnedInText: string;
}

export type ReadinessResult =
  | { ready: true; shots: EditShot[] }
  | { ready: false; reason: EditBlockReason; message: string };

export type EditBlockReason =
  | "not_a_reel"
  | "no_shot_plan"
  | "no_frames"
  /**
   * Every missing clip is at Higgsfield with a request id against it. This
   * will pass without anybody acting, so the caller holds rather than fails:
   * on 4 October a job reported "shot 1..6 never submitted" when the honest
   * answer was "not back yet", and the two want opposite responses.
   */
  | "clips_rendering"
  /** At least one shot was never submitted. Nothing is coming. */
  | "clips_missing"
  | "plan_frame_mismatch";

/**
 * Default cap for a reel, in seconds.
 *
 * Phase 1 writes no length to the brief, and a reel that runs long is not
 * refused by any platform — it just stops being watched. 60s is the honest
 * outer bound for Reels and Shorts; the planner is told the number so it
 * paces the cut rather than discovering the limit at validation.
 */
export const DEFAULT_MAX_REEL_SEC = 60;

/** Planned shot lengths plus a little, so the planner is not forced to use every frame. */
export function maxReelSeconds(shots: readonly EditShot[], cap = DEFAULT_MAX_REEL_SEC): number {
  const planned = shots.reduce((total, shot) => total + shot.plannedDurationSec, 0);
  return Math.min(cap, Math.max(10, Math.round(planned)));
}

function numeric(value: number | string | null): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    // numeric columns come back as strings through PostgREST.
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isReel(brief: BriefForEdit): boolean {
  if (brief.media_type !== null && brief.media_type !== "video") return false;
  if (brief.content_format === "reel") return true;
  return brief.format_code === "F6" || brief.format_code === "F7";
}

/**
 * Whether this reel can be edited now, and the shots to edit if so.
 *
 * Every shot in the plan must have a frame, and every frame a clip. A shot
 * that was submitted but has not come back says so by name, because "waiting
 * on Higgsfield" and "Higgsfield failed" are different problems for whoever
 * reads the job events.
 */
export function editReadiness(brief: BriefForEdit, frames: readonly FrameRowForEdit[]): ReadinessResult {
  if (!isReel(brief)) {
    return { ready: false, reason: "not_a_reel", message: "Editing runs on a reel. This brief is not one." };
  }
  const plan = parseStoredShotPlan(brief.frame_plan);
  if (plan.problem) return { ready: false, reason: "no_shot_plan", message: plan.problem };
  if (frames.length === 0) {
    return {
      ready: false,
      reason: "no_frames",
      message: "This reel has no shots on file yet. Stills and motion run before the edit.",
    };
  }

  const ordered = [...frames].sort((a, b) => a.position - b.position);
  if (ordered.length !== plan.shots.length) {
    return {
      ready: false,
      reason: "plan_frame_mismatch",
      message: `The plan has ${plan.shots.length} shots and ${ordered.length} are on file. The edit needs the whole reel.`,
    };
  }

  const shots: EditShot[] = [];
  const waiting: number[] = [];
  const neverSubmitted: number[] = [];
  ordered.forEach((frame, index) => {
    const clipPath = frame.clip_path?.trim() ?? "";
    if (!clipPath) {
      if (frame.provider_job_id?.trim()) waiting.push(frame.position);
      else neverSubmitted.push(frame.position);
      return;
    }
    const planned = plan.shots[index]!;
    shots.push({
      shot: frame.position,
      frameId: frame.id,
      beat: frame.beat?.trim() || planned.beat,
      plannedDurationSec: numeric(frame.duration_sec) ?? planned.duration_sec,
      shotSourceKind: frame.shot_source_kind?.trim() || planned.shot_source_kind,
      clipPath,
      burnedInText: frame.caption?.trim() ?? "",
    });
  });

  if (waiting.length > 0 || neverSubmitted.length > 0) {
    // Only waiting, nothing unsubmitted: the clips are coming. Said as a wait
    // rather than a fault, because the caller holds on one and fails on the
    // other.
    if (neverSubmitted.length === 0) {
      return {
        ready: false,
        reason: "clips_rendering",
        message: `Waiting on Higgsfield: ${list(waiting)} submitted and no clip back yet.`,
      };
    }
    const parts = [
      waiting.length > 0 ? `${list(waiting)} submitted to Higgsfield but no clip has come back` : null,
      neverSubmitted.length > 0 ? `${list(neverSubmitted)} never submitted` : null,
    ].filter((part): part is string => part !== null);
    return {
      ready: false,
      reason: "clips_missing",
      message: `The edit needs a clip for every shot. ${parts.join("; ")}.`,
    };
  }

  return { ready: true, shots };
}

function list(positions: readonly number[]): string {
  const labels = positions.map((position) => `shot ${position}`);
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * The brief as the planner reads it, and as the claim check measures against.
 *
 * Only fields that carry words meant for the viewer. visual_direction and
 * production notes describe how to shoot, not what is said, and a number in
 * them ("3 point lighting") would silently license a caption claiming 3 of
 * something. The check is only as good as what it is given.
 */
export function briefTextForEdit(brief: BriefForEdit): string {
  return (
    [
      ["Hook", brief.hook],
      ["Script", brief.script],
      ["Proof", brief.proof],
      ["Call to action", brief.call_to_action],
      ["Runs on", brief.channel_intent],
    ] as Array<[string, string | null]>
  )
    .filter(([, value]) => value?.trim())
    .map(([label, value]) => `${label}: ${value!.trim()}`)
    .join("\n");
}

/** Brand never_do as phrases the validator can match. One per line or comma. */
export function bannedPhrases(neverDo: string | null | undefined): string[] {
  return (neverDo ?? "")
    .split(/[\n,;.]+/)
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length >= 3);
}

/**
 * The validation context for a ready reel.
 *
 * Clip lengths are the probed ones, not the planned ones: Higgsfield returns
 * what its model produced, and a cut written against a planned 4s clip that
 * came back 3.2s would be refused at render time instead of at validation.
 */
export function editContext(input: {
  shots: readonly EditShot[];
  probedDurations: ReadonlyMap<number, number>;
  brief: BriefForEdit;
  neverDo?: string | null;
  maxTotalSec?: number;
}): EdlContext {
  return {
    clips: input.shots.map((shot) => ({
      shot: shot.shot,
      duration_sec: input.probedDurations.get(shot.shot) ?? shot.plannedDurationSec,
      shot_source_kind: shot.shotSourceKind,
      burned_in_text: shot.burnedInText,
    })),
    max_total_sec: input.maxTotalSec ?? maxReelSeconds(input.shots),
    brief_text: briefTextForEdit(input.brief),
    banned_phrases: bannedPhrases(input.neverDo),
  };
}
