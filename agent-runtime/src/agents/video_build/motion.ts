/**
 * Whether motion may run, and which shots are ready to submit.
 *
 * Missing Higgsfield env pauses before any request. When the key, the
 * secret, and both model ids are set, the adapter may submit. Pending and
 * Zoom In are the Cockpit Zoom In catalog id. Any other name that is not
 * already a catalog UUID is not submitted — inventing an id would point
 * DoP at nothing. A shot whose opening still has no https URL is not sent.
 */

import type { ShotPlanEntry } from "../brief/shots.js";
import { resolveMotionPreset } from "./motions.js";

export const HIGGSFIELD_KEY_ENV = "HIGGSFIELD_API_KEY";
export const HIGGSFIELD_SECRET_ENV = "HIGGSFIELD_API_SECRET";
export const HIGGSFIELD_MODEL_DRAFT_ENV = "HIGGSFIELD_MODEL_DRAFT";
export const HIGGSFIELD_MODEL_FINAL_ENV = "HIGGSFIELD_MODEL_FINAL";

const MOTION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MotionEnv {
  apiKey?: string | null;
  apiSecret?: string | null;
  modelDraft?: string | null;
  modelFinal?: string | null;
}

export type MotionDecision =
  | {
      proceed: false;
      stage: "paused";
      retryable: false;
      reason: "missing_higgsfield_credentials";
      message: string;
      modelDraft: null;
      modelFinal: null;
    }
  | {
      proceed: true;
      stage: "ready";
      retryable: false;
      reason: "ready";
      message: string;
      modelDraft: string;
      modelFinal: string;
    };

function present(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

export function readHiggsfieldEnv(env: NodeJS.ProcessEnv = process.env): MotionEnv {
  return {
    apiKey: env[HIGGSFIELD_KEY_ENV],
    apiSecret: env[HIGGSFIELD_SECRET_ENV],
    modelDraft: env[HIGGSFIELD_MODEL_DRAFT_ENV],
    modelFinal: env[HIGGSFIELD_MODEL_FINAL_ENV],
  };
}

export function decideMotion(env: MotionEnv): MotionDecision {
  const missing = [
    present(env.apiKey) ? null : HIGGSFIELD_KEY_ENV,
    present(env.apiSecret) ? null : HIGGSFIELD_SECRET_ENV,
    present(env.modelDraft) ? null : HIGGSFIELD_MODEL_DRAFT_ENV,
    present(env.modelFinal) ? null : HIGGSFIELD_MODEL_FINAL_ENV,
  ].filter((name): name is string => name !== null);

  if (missing.length > 0) {
    const listed =
      missing.length === 1
        ? missing[0]
        : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
    const verb = missing.length === 1 ? "is" : "are";
    return {
      proceed: false,
      stage: "paused",
      retryable: false,
      reason: "missing_higgsfield_credentials",
      message: `Motion paused: ${listed} ${verb} not set. No Higgsfield request was sent.`,
      modelDraft: null,
      modelFinal: null,
    };
  }

  return {
    proceed: true,
    stage: "ready",
    retryable: false,
    reason: "ready",
    message: "Higgsfield credentials are set. Image-to-video can be submitted.",
    modelDraft: present(env.modelDraft),
    modelFinal: present(env.modelFinal),
  };
}

export function isMotionCatalogId(value: string | null | undefined): boolean {
  return MOTION_UUID.test(value?.trim() ?? "");
}

export interface MotionFrameRef {
  id: string;
  position: number;
  providerJobId: string | null;
}

export interface MotionSubmitCall {
  kind: "submit";
  position: number;
  frameId: string;
  prompt: string;
  imageUrl: string;
  motionId: string;
  strength: number;
  modelId: string;
}

export interface MotionPollCall {
  kind: "poll";
  position: number;
  frameId: string;
  requestId: string;
}

export type MotionCall = MotionSubmitCall | MotionPollCall;

export type MotionPlan =
  | { ok: true; calls: MotionCall[] }
  | {
      ok: false;
      reason: "stills_not_ready" | "motion_preset_pending";
      message: string;
    };

function httpsUrl(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed.startsWith("https://")) return null;
  return trimmed;
}

/**
 * Submit every shot, or none.
 *
 * A shot that already has a provider request id is polled and not submitted
 * again. If any shot is not ready and nothing has been submitted yet, the
 * whole reel waits — a partial submit would spend on an unfinished plan.
 * Polls already on file still run, so a retry does not submit twice.
 */
export function prepareMotionCalls(input: {
  shots: readonly ShotPlanEntry[];
  frames: readonly MotionFrameRef[];
  stillUrlByPosition: ReadonlyMap<number, string>;
  modelId: string;
  strength?: number;
}): MotionPlan {
  const strength = input.strength ?? 1;
  const calls: MotionCall[] = [];
  const stillProblems: number[] = [];
  const motionProblems: Array<{ position: number; preset: string }> = [];

  input.shots.forEach((shot, index) => {
    const position = index + 1;
    const frame = input.frames.find((row) => row.position === position);
    const existing = frame?.providerJobId?.trim() ?? "";
    if (existing) {
      calls.push({ kind: "poll", position, frameId: frame!.id, requestId: existing });
      return;
    }
    const imageUrl = httpsUrl(input.stillUrlByPosition.get(position));
    const resolved = resolveMotionPreset(shot.motion_preset);
    // A UUID already stored on the shot is a catalog id the plan carried.
    // It is not replaced. Only pending and Zoom In are filled in from the
    // Cockpit mapping. Any other name stays unresolved.
    const motionId = resolved.ok
      ? resolved.id
      : isMotionCatalogId(shot.motion_preset)
        ? shot.motion_preset.trim()
        : "";
    if (!frame || !imageUrl) {
      stillProblems.push(position);
      return;
    }
    if (!motionId) {
      motionProblems.push({ position, preset: shot.motion_preset.trim() || "(blank)" });
      return;
    }
    calls.push({
      kind: "submit",
      position,
      frameId: frame.id,
      prompt: shot.beat,
      imageUrl,
      motionId,
      strength,
      modelId: input.modelId,
    });
  });

  const polls = calls.filter((call): call is MotionPollCall => call.kind === "poll");
  if (stillProblems.length > 0 || motionProblems.length > 0) {
    // A request id already stored is polled. New submits wait until every
    // remaining shot is ready, so a blocked still does not spend on its neighbours.
    if (polls.length > 0) {
      return { ok: true, calls: polls };
    }
    const reason = stillProblems.length > 0 ? "stills_not_ready" : "motion_preset_pending";
    const parts: string[] = [];
    if (stillProblems.length > 0) {
      parts.push(`opening stills are not ready for shot ${stillProblems.join(", ")}`);
    }
    if (motionProblems.length > 0) {
      const listed = motionProblems.map((item) => `"${item.preset}" (shot ${item.position})`).join(", ");
      parts.push(`motion preset ${listed} is not a known catalog id`);
    }
    return {
      ok: false,
      reason,
      message: `Motion paused: ${parts.join("; ")}. No Higgsfield request was sent.`,
    };
  }

  if (calls.length === 0) {
    return {
      ok: false,
      reason: "stills_not_ready",
      message: "Motion paused: this reel has no shots to submit. No Higgsfield request was sent.",
    };
  }
  return { ok: true, calls };
}

/** What the job should do after submit/poll statuses come back. */
export function motionFollowUp(statuses: readonly string[]): {
  ok: boolean;
  retryable: boolean;
  message: string;
} {
  const normalized = statuses.map((status) => status.trim().toLowerCase());
  if (normalized.length === 0) {
    return {
      ok: false,
      retryable: false,
      message: "Motion paused: nothing was submitted. No Higgsfield request was sent.",
    };
  }
  if (normalized.some((status) => status === "failed" || status === "nsfw")) {
    return {
      ok: false,
      retryable: false,
      message: "Higgsfield reported a shot as failed. The request id is stored. It was not submitted again.",
    };
  }
  if (normalized.every((status) => status === "completed")) {
    return {
      ok: true,
      retryable: false,
      message: "Higgsfield completed the submitted shots.",
    };
  }
  return {
    ok: false,
    retryable: true,
    message: "Higgsfield is still rendering. The request id is stored. It will be polled, not submitted again.",
  };
}
