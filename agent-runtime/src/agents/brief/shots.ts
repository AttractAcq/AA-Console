import { MAX_FRAMES, MIN_FRAMES } from "../../content/format.js";
import { MAX_CAPTION_CHARS } from "../video_edit/edl.js";
import {
  MOTION_PRESET_PENDING,
  resolveMotionPreset,
  ZOOM_IN_MOTION_ID,
  ZOOM_IN_MOTION_NAME,
} from "../video_build/motions.js";

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
 * Token a planner may still emit. Phase 1 stores the Zoom In catalog UUID
 * instead. The token is accepted and replaced; it is not what gets written.
 */
export const MOTION_PRESET_PLACEHOLDER = MOTION_PRESET_PENDING;

export { ZOOM_IN_MOTION_ID, ZOOM_IN_MOTION_NAME };

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
    "Both are generated visual keyframes animated into video shots. They need no client assets and no proof footage.",
    "Each beat must specify what the viewer sees and what visibly changes: a subject action, an environmental change, or a reveal. Do not write a headline, graphic card, diagram or abstract lesson as a shot. Carry the argument in the brief so the editor can caption it after animation.",
    "For this generated-video route, prefer an object-led visual treatment with two or three repeatable, unlabelled physical elements. Avoid visible hands, fingers and other anatomy as the continuing subject; current motion generation struggles to preserve them across shots. Avoid writing actions and close views of printed documents: the model can invent fake handwriting, pseudo-text, figures and logos. Keep any paper completely blank or show only its shape and movement. Never make a viewer's understanding depend on AI-rendered letters, numbers, page counts or a readable object label. Put all exact wording, evidence and numbers in the script for real editor captions instead.",
    "Keep the cast, location and physical props consistent across the visual direction and every shot. If the visual direction specifies one person or one pair of hands, no later shot may introduce another person or pair.",
    `The Phase 1 export is silent with editor-added captions. Do not write voiceover or narration instructions. The script has exactly one SHOT n: caption for each planned shot, each at most ${MAX_CAPTION_CHARS} characters; do not pack several sentences into a shot. If the hook names an exact first caption, keep that line within ${MAX_CAPTION_CHARS} characters. The call_to_action field must be one exact viewer-facing line within ${MAX_CAPTION_CHARS} characters, not a paragraph of edit directions; it must fit on the last shot or end card.`,
    "Submit a shot plan. Each shot has a beat, a duration in seconds, shot_source_kind ai_generated,",
    `and a motion_preset. For compatibility with the original DoP route use ${ZOOM_IN_MOTION_NAME}, catalog id ${ZOOM_IN_MOTION_ID}; the selected video model will direct motion from the beat rather than force a digital zoom.`,
    `Write that id. "${MOTION_PRESET_PLACEHOLDER}" and "${ZOOM_IN_MOTION_NAME}" are accepted and stored as that id.`,
    "Do not invent a motion UUID. Any other name is stored as written, and motion pauses until a catalog confirms it.",
    "Do not mark any shot as a client asset or as proof.",
    "slot_role is not yours to choose. Leave quota buckets alone.",
  ].join(" ");
}

/** The editor cannot faithfully fit an overlong exact line into one caption. */
export function exactFirstCaption(hook: string): string | null {
  return /\bfirst\s+(?:caption|line)\b[^\n:"“]{0,40}:\s*["“]([^"”]+)["”]/i.exec(hook)?.[1]?.trim() ?? null;
}

/** Fill only an omitted final caption from the model's separately approved CTA. */
export function completeMissingFinalReelCaption(submitted: Record<string, unknown>): Record<string, unknown> {
  const frames = Array.isArray(submitted.frames) ? submitted.frames : [];
  const script = String(submitted.script ?? "").trim();
  const cta = String(submitted.call_to_action ?? "").trim();
  if (frames.length < MIN_FRAMES || frames.length > MAX_FRAMES || !script || !cta
      || cta.length > MAX_CAPTION_CHARS || script.includes(cta)) return submitted;
  const captions = [...script.matchAll(/^\s*SHOT\s+(\d+)\s*:\s*(.+)$/gim)];
  if (captions.length !== frames.length - 1
      || captions.some((caption, index) => Number(caption[1]) !== index + 1)) return submitted;
  return { ...submitted, script: `${script}\nSHOT ${frames.length}: ${cta}` };
}

export function reelCopyProblem(submitted: Record<string, unknown>, brandNeverDo = "", allowedColours: string[] | null = null): string | null {
  const hook = String(submitted.hook ?? "");
  const cta = String(submitted.call_to_action ?? "").trim();
  const visualDirection = String(submitted.visual_direction ?? "");
  const frames = Array.isArray(submitted.frames) ? submitted.frames : [];
  for (const [index, raw] of frames.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const beat = String((raw as Record<string, unknown>).beat ?? "");
    if (/\b(?:writ(?:e|es|ing|ten)|handwrit(?:ing|ten)|printed|paragraphs?|words?|letters?|glyphs?)\b/i.test(beat)) {
      return `Shot ${index + 1} depends on generated writing or printed words. Keep the physical object unlettered and put exact language in the editor's captions.`;
    }
  }
  if (/\b(?:same|single|one|only)\s+(?:pair\s+of\s+(?:[\w-]+\s+){0,3}hands|person|actor|subject|character)\b/i.test(visualDirection)) {
    for (const [index, raw] of frames.entries()) {
      if (!raw || typeof raw !== "object") continue;
      const beat = String((raw as Record<string, unknown>).beat ?? "");
      if (/\b(?:a|the)\s+(?:second|another|additional)\s+(?:pair\s+of\s+(?:[\w-]+\s+){0,3}hands|person|actor|subject|character)\b/i.test(beat)) {
        return `Shot ${index + 1} introduces another person or pair of hands, contradicting the reel's single-cast visual direction.`;
      }
    }
  }
  const firstLine = exactFirstCaption(hook);
  if (firstLine && firstLine.length > MAX_CAPTION_CHARS) {
    return `The reel's exact first caption is ${firstLine.length} characters; keep it within ${MAX_CAPTION_CHARS}.`;
  }
  if (cta.length > MAX_CAPTION_CHARS) {
    return `The reel's call to action is ${cta.length} characters; write one exact line within ${MAX_CAPTION_CHARS}.`;
  }
  if (/\bvoice\s*-?over\b|\bnarrat(?:ion|e|or)\b/i.test(cta)) {
    return "A Phase 1 reel has no voiceover source. Write the call to action as on-screen text.";
  }
  if (allowedColours) {
    const allowed = new Set(allowedColours.map((value) => value.toLowerCase()));
    const creativeText = [submitted.script, submitted.visual_direction, submitted.editor_notes,
      ...((Array.isArray(submitted.frames) ? submitted.frames : []) as Array<Record<string, unknown>>)
        .flatMap((frame) => [frame.beat, frame.subject, frame.composition, frame.background])]
      .map((value) => String(value ?? "")).join(" ");
    const invented = [...creativeText.matchAll(/#[0-9a-f]{6}\b/gi)]
      .map((match) => match[0].toLowerCase()).find((value) => !allowed.has(value));
    if (invented) return `The reel brief specifies ${invented}, which is not in the client's recorded visual brand palette.`;
  }
  if (/hand\s*-?shake/i.test(brandNeverDo)) {
    const frames = Array.isArray(submitted.frames) ? submitted.frames : [];
    for (const [index, raw] of frames.entries()) {
      if (!raw || typeof raw !== "object") continue;
      const frame = raw as Record<string, unknown>;
      const scene = [frame.beat, frame.subject, frame.composition, frame.background]
        .map((part) => String(part ?? "")).join(" ");
      if (/hand\s*-?shake|hands?\b.{0,60}\b(?:meet|greet|shake)|\bshak(?:e|es|ing)\s+hands?\b|\bextend(?:s|ing)?\s+(?:his|her|their|a)\s+hand\b/i.test(scene)) {
        return `Shot ${index + 1} depicts a handshake, which this client's visual brand forbids. Choose a different visible action.`;
      }
    }
  }
  const script = String(submitted.script ?? "").trim();
  if (script) {
    const frames = Array.isArray(submitted.frames) ? submitted.frames : [];
    const captions = [...script.matchAll(/^\s*SHOT\s+(\d+)\s*:\s*(.+)$/gim)];
    if (frames.length > 0 && captions.length !== frames.length) {
      return `The silent reel needs exactly one SHOT n: caption line per planned shot (${frames.length} shots, ${captions.length} lines).`;
    }
    for (const [index, caption] of captions.entries()) {
      const number = Number(caption[1]);
      const line = caption[2]!.trim().replace(/^["“]|["”]$/g, "");
      if (number !== index + 1) return "Number the SHOT n: caption lines once, in shot order.";
      if (line.length > MAX_CAPTION_CHARS) {
        return `SHOT ${number} has ${line.length} caption characters; keep each viewer-facing line within ${MAX_CAPTION_CHARS}.`;
      }
    }
  }
  return null;
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
              description: "One line naming the shot's narrative purpose, visible subject and physical change over time. No title cards, abstract diagrams, invented statistics, prices, or quotes.",
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
              description: `Higgsfield motions-catalog id. Phase 1 default is ${ZOOM_IN_MOTION_NAME} (${ZOOM_IN_MOTION_ID}). "${MOTION_PRESET_PLACEHOLDER}" and "${ZOOM_IN_MOTION_NAME}" are stored as that id. Do not invent a UUID.`,
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
      problem: `${label} needs a motion preset. Phase 1 uses ${ZOOM_IN_MOTION_NAME} (${ZOOM_IN_MOTION_ID}). "${MOTION_PRESET_PLACEHOLDER}" is accepted and stored as that id.`,
    };
  }

  // Known SoT names become the catalog UUID. Anything else is kept verbatim
  // so a later pause can name it. No other UUID is filled in here.
  const resolved = resolveMotionPreset(motion);
  return {
    shot: {
      beat,
      duration_sec: duration,
      shot_source_kind: SHOT_SOURCE_GENERATED,
      motion_preset: resolved.ok ? resolved.id : motion,
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
    .map((shot, i) => `${i + 1}. ${shot.beat} (${shot.duration_sec}s, generated, motion ${motionForReader(shot.motion_preset)})`)
    .join("\n");
}

function motionForReader(preset: string): string {
  const resolved = resolveMotionPreset(preset);
  if (resolved.ok && resolved.id === ZOOM_IN_MOTION_ID) return `${ZOOM_IN_MOTION_NAME} ${ZOOM_IN_MOTION_ID}`;
  return preset;
}
