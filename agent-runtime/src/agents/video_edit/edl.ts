/**
 * Edit decision list (EDL) for an AI-cut reel.
 *
 * The model decides the cut; code renders it. Nothing the model writes goes
 * to ffmpeg as text: it fills this shape, parseEdl turns untrusted JSON into
 * typed values, and validateEdl checks it against the clips actually on file.
 * render.ts only ever sees an EDL that passed both.
 *
 * Spike only. Not registered as an agent and not read by the worker.
 */

export const TRANSITIONS = ["cut", "crossfade"] as const;
export type Transition = (typeof TRANSITIONS)[number];

export const CAPTION_POSITIONS = ["top", "middle", "bottom"] as const;
export type CaptionPosition = (typeof CAPTION_POSITIONS)[number];

/** A crossfade shorter than this reads as a glitch, longer eats the shot. */
export const CROSSFADE_SEC = 0.4;
/** Shortest segment worth keeping. Anything less is a flash frame. */
export const MIN_SEGMENT_SEC = 0.5;
/** Shortest time a caption can be read in. */
export const MIN_CAPTION_SEC = 0.8;
/** Long captions overflow a 1080-wide frame at the size render.ts uses. */
export const MAX_CAPTION_CHARS = 60;
export const MAX_END_CARD_SEC = 4;

export interface EdlSegment {
  /** Shot position from the shot plan. Not a file path. */
  shot: number;
  in_sec: number;
  out_sec: number;
  /** How this segment enters from the previous one. Ignored on the first. */
  transition: Transition;
}

export interface EdlCaption {
  text: string;
  /** On the finished timeline, not inside a clip. */
  start_sec: number;
  end_sec: number;
  position: CaptionPosition;
}

export interface Edl {
  segments: EdlSegment[];
  captions: EdlCaption[];
  /** Empty text means no end card. */
  end_card_text: string;
  end_card_sec: number;
  /** The model's reasoning for the human reviewer. Never rendered. */
  notes: string;
}

/** What validateEdl checks the plan against. */
export interface EdlContext {
  clips: ReadonlyArray<{
    shot: number;
    duration_sec: number;
    /** source_asset is proof footage: cut it, never alter it. */
    shot_source_kind: string;
    /** The line the shot already shows. A caption over it would double the text. */
    burned_in_text: string;
  }>;
  max_total_sec: number;
  /** Brief text. A number in a caption that is not in here is invented. */
  brief_text: string;
  /** From brand never_do, split by the caller. Matched case-insensitively. */
  banned_phrases: readonly string[];
}

/**
 * Tool schema for the planner. Strict-mode safe: no min/max keywords, every
 * property required. Bounds are enforced in validateEdl instead.
 */
export const EDL_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["segments", "captions", "end_card_text", "end_card_sec", "notes"],
  properties: {
    segments: {
      type: "array",
      description: "The cut, in playback order. A shot may be used more than once.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["shot", "in_sec", "out_sec", "transition"],
        properties: {
          shot: { type: "integer", description: "Shot position from the shot list." },
          in_sec: { type: "number", description: "Start inside that clip, in seconds." },
          out_sec: { type: "number", description: "End inside that clip, in seconds." },
          transition: { type: "string", enum: [...TRANSITIONS] },
        },
      },
    },
    captions: {
      type: "array",
      description: "On-screen text, timed on the finished reel.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "start_sec", "end_sec", "position"],
        properties: {
          text: { type: "string" },
          start_sec: { type: "number", description: "When it appears, in seconds from the start of the finished reel." },
          end_sec: { type: "number", description: "When it disappears, in seconds from the start of the finished reel." },
          position: { type: "string", enum: [...CAPTION_POSITIONS] },
        },
      },
    },
    end_card_text: { type: "string", description: "Call to action on a closing card, or empty for none." },
    end_card_sec: {
      type: "number",
      description:
        `How long the end card holds, in seconds — a duration, not a time on the reel. ` +
        `Between 1 and ${MAX_END_CARD_SEC}, and it counts towards the runtime cap. Use 0 when there is no end card.`,
    },
    notes: { type: "string", description: "Why this cut, for the human reviewer." },
  },
};

export type ParseResult = { ok: true; edl: Edl } | { ok: false; problem: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Untrusted JSON to an Edl. Shape only; meaning is validateEdl's job. */
export function parseEdl(raw: unknown): ParseResult {
  if (!isRecord(raw)) return { ok: false, problem: "The edit plan is not an object." };
  if (!Array.isArray(raw.segments) || raw.segments.length === 0) {
    return { ok: false, problem: "The edit plan has no segments." };
  }
  const segments: EdlSegment[] = [];
  for (const [i, item] of raw.segments.entries()) {
    if (!isRecord(item)) return { ok: false, problem: `Segment ${i + 1} is not an object.` };
    const { shot, in_sec, out_sec, transition } = item;
    if (!Number.isInteger(shot) || !finite(in_sec) || !finite(out_sec)) {
      return { ok: false, problem: `Segment ${i + 1} needs a shot number and in/out seconds.` };
    }
    if (!TRANSITIONS.includes(transition as Transition)) {
      return { ok: false, problem: `Segment ${i + 1} has an unknown transition.` };
    }
    segments.push({ shot: shot as number, in_sec, out_sec, transition: transition as Transition });
  }
  const captions: EdlCaption[] = [];
  for (const [i, item] of (Array.isArray(raw.captions) ? raw.captions : []).entries()) {
    if (!isRecord(item)) return { ok: false, problem: `Caption ${i + 1} is not an object.` };
    const { text, start_sec, end_sec, position } = item;
    if (typeof text !== "string" || !finite(start_sec) || !finite(end_sec)) {
      return { ok: false, problem: `Caption ${i + 1} needs text and start/end seconds.` };
    }
    if (!CAPTION_POSITIONS.includes(position as CaptionPosition)) {
      return { ok: false, problem: `Caption ${i + 1} has an unknown position.` };
    }
    captions.push({ text, start_sec, end_sec, position: position as CaptionPosition });
  }
  const endText = typeof raw.end_card_text === "string" ? raw.end_card_text : "";
  const endSec = finite(raw.end_card_sec) ? raw.end_card_sec : 0;
  return {
    ok: true,
    edl: {
      segments,
      captions,
      end_card_text: endText.trim(),
      end_card_sec: endText.trim() ? endSec : 0,
      notes: typeof raw.notes === "string" ? raw.notes : "",
    },
  };
}

/**
 * Where each segment sits on the finished timeline.
 *
 * A crossfade overlaps its predecessor, so a segment's start is not the sum
 * of the lengths before it. render.ts needs this to place an xfade offset and
 * validateEdl needs it to tell which shot is on screen when a caption is, so
 * it lives here rather than being worked out twice and drifting apart.
 */
export function segmentWindows(segments: readonly EdlSegment[]): Array<{ start: number; end: number }> {
  const windows: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  segments.forEach((segment, i) => {
    const length = segment.out_sec - segment.in_sec;
    const start = i > 0 && segment.transition === "crossfade" ? cursor - CROSSFADE_SEC : cursor;
    windows.push({ start, end: start + length });
    cursor = start + length;
  });
  return windows;
}

/** Length of the cut, before the end card. Crossfades overlap their neighbours. */
export function segmentsDuration(segments: readonly EdlSegment[]): number {
  const windows = segmentWindows(segments);
  return windows.length > 0 ? windows[windows.length - 1]!.end : 0;
}

export function totalDuration(edl: Edl): number {
  return segmentsDuration(edl.segments) + (edl.end_card_text ? edl.end_card_sec : 0);
}

function numbersIn(text: string): string[] {
  return text.match(/\d+(?:[.,]\d+)?/g) ?? [];
}

/**
 * Every reason this plan cannot be rendered as-is. Empty means renderable.
 * A list, not the first failure, so one revise call can fix all of them.
 */
export function validateEdl(edl: Edl, context: EdlContext): string[] {
  const problems: string[] = [];
  const clips = new Map(context.clips.map((clip) => [clip.shot, clip]));

  edl.segments.forEach((segment, i) => {
    const label = `Segment ${i + 1} (shot ${segment.shot})`;
    const clip = clips.get(segment.shot);
    if (!clip) {
      problems.push(`${label} names a shot that has no clip.`);
      return;
    }
    if (segment.in_sec < 0 || segment.out_sec > clip.duration_sec + 0.05) {
      problems.push(`${label} runs outside the clip, which is ${clip.duration_sec.toFixed(2)}s long.`);
    }
    const length = segment.out_sec - segment.in_sec;
    if (length < MIN_SEGMENT_SEC) {
      problems.push(`${label} is ${length.toFixed(2)}s. The shortest usable segment is ${MIN_SEGMENT_SEC}s.`);
    }
    if (i > 0 && segment.transition === "crossfade") {
      const previous = edl.segments[i - 1]!;
      if (length <= CROSSFADE_SEC || previous.out_sec - previous.in_sec <= CROSSFADE_SEC) {
        problems.push(`${label} crossfades with a segment too short to overlap.`);
      }
      // A dissolve over proof footage changes what the viewer sees of it.
      const previousClip = clips.get(previous.shot);
      if (clip.shot_source_kind === "source_asset" || previousClip?.shot_source_kind === "source_asset") {
        problems.push(`${label} crossfades over client footage. Proof shots are cut, not blended.`);
      }
    }
  });

  if (edl.end_card_text && (edl.end_card_sec < 1 || edl.end_card_sec > MAX_END_CARD_SEC)) {
    problems.push(`The end card runs ${edl.end_card_sec}s. It has to be between 1 and ${MAX_END_CARD_SEC}s.`);
  }

  const total = totalDuration(edl);
  if (total > context.max_total_sec) {
    problems.push(`The reel runs ${total.toFixed(1)}s. This format allows ${context.max_total_sec}s.`);
  }

  const briefNumbers = new Set(numbersIn(context.brief_text));
  const banned = context.banned_phrases.map((phrase) => phrase.trim().toLowerCase()).filter(Boolean);
  const texts = [
    ...edl.captions.map((caption, i) => ({ label: `Caption ${i + 1}`, text: caption.text })),
    ...(edl.end_card_text ? [{ label: "The end card", text: edl.end_card_text }] : []),
  ];
  for (const { label, text } of texts) {
    if (!text.trim()) problems.push(`${label} is empty.`);
    if (text.length > MAX_CAPTION_CHARS) {
      problems.push(`${label} is ${text.length} characters. It has to fit in ${MAX_CAPTION_CHARS}.`);
    }
    // A figure on screen that the brief does not contain is a claim nobody approved.
    for (const number of numbersIn(text)) {
      if (!briefNumbers.has(number)) problems.push(`${label} says "${number}", which is not in the brief.`);
    }
    const lower = text.toLowerCase();
    for (const phrase of banned) {
      if (lower.includes(phrase)) problems.push(`${label} uses "${phrase}", which the brand bans.`);
    }
  }

  edl.captions.forEach((caption, i) => {
    const label = `Caption ${i + 1}`;
    if (caption.end_sec - caption.start_sec < MIN_CAPTION_SEC) {
      problems.push(`${label} is on screen for under ${MIN_CAPTION_SEC}s, too short to read.`);
    }
    if (caption.start_sec < 0 || caption.end_sec > total + 0.05) {
      problems.push(`${label} runs outside the reel.`);
    }
  });
  // A caption over a shot that already carries its line puts two texts in two
  // typefaces in the same frame. On AA-0121 every shot had a burned-in line
  // and all three captions landed on one, which is what the cut looked like.
  const windows = segmentWindows(edl.segments);
  edl.captions.forEach((caption, i) => {
    const collisions = new Set<string>();
    edl.segments.forEach((segment, s) => {
      const clip = clips.get(segment.shot);
      const burned = clip?.burned_in_text?.trim();
      if (!burned) return;
      const window = windows[s]!;
      // Touching at a boundary is not an overlap.
      if (caption.start_sec < window.end - 0.05 && caption.end_sec > window.start + 0.05) {
        collisions.add(`shot ${segment.shot}`);
      }
    });
    if (collisions.size > 0) {
      const many = collisions.size > 1;
      problems.push(
        `Caption ${i + 1} is on screen over ${[...collisions].join(" and ")}, ` +
          `which already ${many ? "show their own lines" : "shows its own line"}. ` +
          `Drop the caption or move it to a shot with no text in it.`,
      );
    }
  });

  const byPosition = new Map<CaptionPosition, EdlCaption[]>();
  for (const caption of edl.captions) {
    byPosition.set(caption.position, [...(byPosition.get(caption.position) ?? []), caption]);
  }
  for (const [position, list] of byPosition) {
    const sorted = [...list].sort((a, b) => a.start_sec - b.start_sec);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i]!.start_sec < sorted[i - 1]!.end_sec) {
        problems.push(`Two ${position} captions overlap at ${sorted[i]!.start_sec.toFixed(1)}s.`);
      }
    }
  }

  return problems;
}
