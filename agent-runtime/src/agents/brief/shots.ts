import { MAX_FRAMES, MIN_FRAMES } from "../../content/format.js";

/**
 * Shot source on a frame.
 *
 * The wiring spec says "generated" or "client_asset". Cockpit's integrity
 * guard says `ai_generated` or `source_asset`, and that guard is the rule
 * Phase 2 will enforce: a proof shot is source_asset, never ai_generated.
 * One spelling, the Cockpit one, so the later check does not translate.
 *
 * Phase 1 F6/F7 are generated only. `source_asset` exists so the column
 * check is real, and this planner refuses to emit it.
 */
export const SHOT_SOURCE_GENERATED = "ai_generated" as const;
export const SHOT_SOURCE_CLIENT_ASSET = "source_asset" as const;

/** Phase 1 formats. Neither needs a client asset. */
export const PHASE1_FORMAT_CODES = ["F6", "F7"] as const;
export type Phase1FormatCode = (typeof PHASE1_FORMAT_CODES)[number];

/**
 * Stored until a Higgsfield motions-catalog id is chosen.
 * Not a UUID. Inventing one would point a later submit at nothing.
 */
export const MOTION_PRESET_PLACEHOLDER = "pending";

export interface ShotPlanEntry {
  beat: string;
  duration_sec: number;
  shot_source_kind: typeof SHOT_SOURCE_GENERATED;
  motion_preset: string;
}

export function isPhase1FormatCode(value: unknown): value is Phase1FormatCode {
  return value === "F6" || value === "F7";
}

/** Why this idea cannot be briefed as a reel, or null if it can. */
export function reelBriefProblem(contentFormat: string, mediaType: string): string | null {
  if (contentFormat !== "reel") return null;
  if (mediaType === "video") return null;
  return "A reel is a video. This idea is not, so it cannot be briefed as one.";
}

/**
 * What the brief model is told when the piece is a reel.
 * The tool schema is the enforcement; this is so the model is not guessing
 * what a shot is.
 */
export function reelPlannerNote(): string {
  return [
    "Format: video — produced as a reel.",
    "Phase 1 formats are F6 (mechanism explainer) and F7 (problem cold-open).",
    "Both are generated stills with motion applied. They need no client assets and no proof footage.",
    "Submit a shot plan. Each shot has a beat, a duration in seconds, shot_source_kind ai_generated,",
    `and motion_preset "${MOTION_PRESET_PLACEHOLDER}" unless you were given a real catalog id.`,
    "Do not invent a motion UUID. Do not mark any shot as a client asset or as proof.",
    "slot_role is not yours to choose. Leave quota buckets alone.",
  ].join(" ");
}

/** The two extra properties a reel brief submits, and nothing a carousel does. */
export function reelSubmitProperties(): {
  properties: Record<string, unknown>;
  required: string[];
} {
  return {
    properties: {
      format_code: {
        type: "string",
        enum: [...PHASE1_FORMAT_CODES],
        description:
          "F6 mechanism explainer or F7 problem cold-open. Both are generated. Formats that need client assets are not available here.",
      },
      frames: {
        type: "array",
        description: `Ordered shots. Between ${MIN_FRAMES} and ${MAX_FRAMES}. Every shot is generated. No two shots do the same job.`,
        items: {
          type: "object",
          properties: {
            beat: {
              type: "string",
              description: "What this shot does in the reel. One line. No invented statistics, prices, or quotes.",
            },
            duration_sec: {
              type: "number",
              description: "Length of this shot in seconds. A positive number, typically 2 to 6.",
            },
            shot_source_kind: {
              type: "string",
              enum: [SHOT_SOURCE_GENERATED],
              description:
                "Phase 1 shots are ai_generated. source_asset is not a choice: F6 and F7 do not use client assets.",
            },
            motion_preset: {
              type: "string",
              description: `Higgsfield motion id, or "${MOTION_PRESET_PLACEHOLDER}" until a catalog id is chosen. Do not invent a UUID.`,
            },
          },
          required: ["beat", "duration_sec", "shot_source_kind", "motion_preset"],
          additionalProperties: false,
        },
      },
    },
    required: ["format_code", "frames"],
  };
}

function shotCountProblem(count: number): string | null {
  if (count < MIN_FRAMES) return `A reel needs at least ${MIN_FRAMES} shots; this plan has ${count}.`;
  if (count > MAX_FRAMES) return `${MAX_FRAMES} shots is the limit; this plan has ${count}.`;
  return null;
}

function asShot(raw: unknown, index: number): { shot: ShotPlanEntry | null; problem: string } {
  const label = `Shot ${index + 1}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      shot: null,
      problem: `${label} is not a shot. A reel plan carries a beat, a duration, a source kind and a motion preset.`,
    };
  }
  const row = raw as Record<string, unknown>;
  const beat = typeof row.beat === "string" ? row.beat.trim() : "";
  if (!beat) return { shot: null, problem: `${label} has no beat.` };

  const duration = row.duration_sec;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    return { shot: null, problem: `${label} needs a duration in seconds greater than zero.` };
  }
  if (duration > 60) {
    return { shot: null, problem: `${label} is ${duration}s. A shot in this plan is at most 60 seconds.` };
  }

  if (row.shot_source_kind !== SHOT_SOURCE_GENERATED) {
    return {
      shot: null,
      problem: `${label} must be ${SHOT_SOURCE_GENERATED}. Phase 1 reels (F6 and F7) are generated and do not use client assets.`,
    };
  }

  const motion = typeof row.motion_preset === "string" ? row.motion_preset.trim() : "";
  if (!motion) {
    return {
      shot: null,
      problem: `${label} needs a motion preset. Use "${MOTION_PRESET_PLACEHOLDER}" until a catalog id exists.`,
    };
  }

  return {
    shot: {
      beat,
      duration_sec: duration,
      shot_source_kind: SHOT_SOURCE_GENERATED,
      motion_preset: motion,
    },
    problem: "",
  };
}

/** Key order is fixed so a stored line compares equal to the line we wrote. */
export function serializeShot(shot: ShotPlanEntry): string {
  return JSON.stringify({
    beat: shot.beat,
    duration_sec: shot.duration_sec,
    motion_preset: shot.motion_preset,
    shot_source_kind: shot.shot_source_kind,
  });
}

export function shotsFromSubmitted(submitted: Record<string, unknown>): {
  shots: ShotPlanEntry[];
  problem: string | null;
} {
  const raw = submitted.frames;
  if (!Array.isArray(raw)) return { shots: [], problem: shotCountProblem(0) };
  const count = shotCountProblem(raw.length);
  if (count) return { shots: [], problem: count };

  const shots: ShotPlanEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const parsed = asShot(raw[i], i);
    if (!parsed.shot) return { shots: [], problem: parsed.problem };
    shots.push(parsed.shot);
  }
  return { shots, problem: null };
}

export function formatCodeFrom(submitted: Record<string, unknown>): {
  code: Phase1FormatCode | null;
  problem: string | null;
} {
  if (!isPhase1FormatCode(submitted.format_code)) {
    return {
      code: null,
      problem: "A Phase 1 reel is F6 (mechanism explainer) or F7 (problem cold-open).",
    };
  }
  return { code: submitted.format_code, problem: null };
}

/**
 * frame_plan stays text[]. A reel entry is one JSON object per shot, which
 * frame_plan_is_usable already accepts: non-blank, between 2 and 10.
 * Carousel and story lines stay plain text. This does not touch them.
 */
export function shotPlanColumns(submitted: Record<string, unknown>): {
  columns: Record<string, unknown>;
  problem: string | null;
} {
  const code = formatCodeFrom(submitted);
  if (code.problem || !code.code) return { columns: {}, problem: code.problem };
  const plan = shotsFromSubmitted(submitted);
  if (plan.problem) return { columns: {}, problem: plan.problem };
  return {
    columns: {
      frame_plan: plan.shots.map(serializeShot),
      frame_count: plan.shots.length,
      format_code: code.code,
    },
    problem: null,
  };
}

/** Read the plan video_build was handed. Plain carousel lines are not shots. */
export function parseStoredShotPlan(lines: readonly string[] | null | undefined): {
  shots: ShotPlanEntry[];
  problem: string | null;
} {
  if (!lines || lines.length === 0) {
    return { shots: [], problem: "This reel brief has no shot plan." };
  }
  const count = shotCountProblem(lines.length);
  if (count) return { shots: [], problem: count };

  const shots: ShotPlanEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    let raw: unknown;
    try {
      raw = JSON.parse(lines[i] ?? "");
    } catch {
      return { shots: [], problem: `Shot ${i + 1} of the stored plan is not a shot record.` };
    }
    const parsed = asShot(raw, i);
    if (!parsed.shot) return { shots: [], problem: parsed.problem };
    shots.push(parsed.shot);
  }
  return { shots, problem: null };
}

/**
 * The shot list as a person reads it. Null when the submission is not a
 * shot plan, so a carousel's string frames are left to the existing section.
 */
export function readableShotPlan(submitted: Record<string, unknown>): string | null {
  const raw = submitted.frames;
  if (!Array.isArray(raw) || raw.length === 0 || typeof raw[0] === "string") return null;
  const plan = shotsFromSubmitted(submitted);
  if (plan.problem || plan.shots.length === 0) return null;
  return plan.shots
    .map((shot, i) => `${i + 1}. ${shot.beat} (${shot.duration_sec}s, generated, motion ${shot.motion_preset})`)
    .join("\n");
}
