import { z } from "zod";
import { type Caption } from "@remotion/captions";
import { TransitionNameSchema, type TransitionName } from "../components/primitives/TransitionPresets.js";
import { registry, type ComponentName } from "./registry.js";
import { parseIR, type VideoIR } from "./schema.js";

export const FPS = 30;
export const TRANSITION_FRAMES = 18;
export const AUDIO_TAIL_SEC = 0.4;

export const WordTimingSchema = z.strictObject({
  text: z.string().trim().min(1),
  startSec: z.number().finite().nonnegative(),
  endSec: z.number().finite().positive(),
}).refine((word) => word.endSec > word.startSec, "Word must end after it starts");

export const SceneTimingSchema = z.strictObject({
  id: z.string().regex(/^s\d{2}$/),
  // Null means a silent development fixture. Production audio must provide a source.
  audioSrc: z.string().trim().min(1).nullable(),
  durationSec: z.number().finite().positive().max(25),
  words: z.array(WordTimingSchema),
});

export const TimingsSchema = z.strictObject({
  musicSrc: z.string().trim().min(1).nullable().default(null),
  scenes: z.array(SceneTimingSchema),
});
export type Timings = z.infer<typeof TimingsSchema>;

export type TimelineScene = {
  id: string;
  component: ComponentName;
  props: Record<string, unknown>;
  narration: string;
  transitionIn: TransitionName;
  startFrame: number;
  durationInFrames: number;
  audioSrc: string | null;
  audioDurationInFrames: number;
  captions: Caption[];
  chapter: boolean;
  locked: boolean;
};

export type Timeline = {
  version: 1;
  fps: typeof FPS;
  title: string;
  aspects: VideoIR["aspects"];
  totalFrames: number;
  music: VideoIR["music"];
  musicSrc: string | null;
  scenes: TimelineScene[];
  chapters: { title: string; startSec: number }[];
};

function normalizeWords(input: string): string[] {
  return input.toLocaleLowerCase("en").match(/[\p{L}\p{N}]+/gu) ?? [];
}

function alignedStart(phrase: string, words: Timings["scenes"][number]["words"]): number | null {
  const needle = normalizeWords(phrase);
  if (!needle.length) return null;
  const haystack = words.flatMap((word) => normalizeWords(word.text).map((normalized) => ({ normalized, startSec: word.startSec })));
  for (let index = 0; index <= haystack.length - needle.length; index++) {
    if (needle.every((token, offset) => haystack[index + offset]?.normalized === token)) return haystack[index]!.startSec;
  }
  return null;
}

function fillRevealTimes(component: ComponentName, parsedProps: Record<string, unknown>, words: Timings["scenes"][number]["words"], durationSec: number): Record<string, unknown> {
  if (component === "BulletReveal" && !parsedProps.revealAt) {
    const items = parsedProps.items as string[];
    return { ...parsedProps, revealAt: items.map((item, index) => alignedStart(item, words) ?? (durationSec * 0.65 * index / items.length)) };
  }
  if (component === "KineticHeadline" && !parsedProps.revealAt) {
    const headline = parsedProps.words as string[];
    return { ...parsedProps, revealAt: headline.map((word, index) => alignedStart(word, words) ?? (durationSec * 0.65 * index / headline.length)) };
  }
  return parsedProps;
}

function chapterTitle(component: ComponentName, props: Record<string, unknown>): string {
  for (const key of ["title", "heading", "headline", "text", "label"]) {
    const value = props[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 100);
  }
  return component;
}

export function compile(rawIR: unknown, rawTimings: unknown): Timeline {
  const ir = parseIR(rawIR);
  const timings = TimingsSchema.parse(rawTimings);
  // The requested music remains in the IR for audit. Music generation is
  // optional: a failed or disabled bed renders narration without a bed.
  if (timings.scenes.length !== ir.scenes.length) throw new Error("Timings must contain one entry for every IR scene");

  let from = 0;
  const scenes: TimelineScene[] = [];
  const chapters: Timeline["chapters"] = [];
  ir.scenes.forEach((scene, index) => {
    const timing = timings.scenes[index]!;
    if (timing.id !== scene.id) throw new Error(`Timing ${index + 1} must refer to ${scene.id}`);
    if (timing.words.some((word) => word.endSec > timing.durationSec)) throw new Error(`${scene.id}: word timing exceeds audio duration`);
    if (timing.words.some((word, i) => i > 0 && word.startSec < timing.words[i - 1]!.startSec)) throw new Error(`${scene.id}: word timings must be ordered`);
    // Production MP3s already contain the 400 ms silence tail. Silent fixtures
    // have no file, so the compiler supplies their visual tail instead.
    const durationInFrames = Math.max(Math.ceil((timing.durationSec
      + (timing.audioSrc === null ? AUDIO_TAIL_SEC : 0)) * FPS), Math.ceil((scene.minDurationSec ?? 2) * FPS));
    if (durationInFrames > 25 * FPS) throw new Error(`${scene.id}: compiled scene exceeds 25 seconds`);
    if (index > 0 && scene.transitionIn !== "cut") from -= TRANSITION_FRAMES;
    const props = fillRevealTimes(scene.component, registry[scene.component].schema.parse(scene.props), timing.words, timing.durationSec);
    const captions: Caption[] = timing.words.map((word) => ({
      text: `${word.text} `, startMs: Math.round(word.startSec * 1000), endMs: Math.round(word.endSec * 1000),
      timestampMs: Math.round(word.startSec * 1000), confidence: null,
    }));
    scenes.push({ id: scene.id, component: scene.component, props, narration: scene.narration,
      transitionIn: TransitionNameSchema.parse(scene.transitionIn), startFrame: from, durationInFrames,
      audioSrc: timing.audioSrc, audioDurationInFrames: Math.ceil(timing.durationSec * FPS),
      captions, chapter: scene.chapter, locked: scene.locked });
    if (scene.chapter) chapters.push({ title: chapterTitle(scene.component, props), startSec: from / FPS });
    from += durationInFrames;
  });
  scenes.forEach((scene, index) => {
    const nextTransition = scenes[index + 1]?.transitionIn;
    const visibleUntilSec = (scene.durationInFrames - (nextTransition && nextTransition !== "cut" ? TRANSITION_FRAMES : 0)) / FPS;
    if (scene.component === "BulletReveal" || scene.component === "KineticHeadline") {
      const revealAt = scene.props.revealAt as number[] | undefined;
      const blocks = scene.component === "BulletReveal" ? scene.props.items as string[] : scene.props.words as string[];
      revealAt?.forEach((at, blockIndex) => {
        const wordCount = normalizeWords(blocks[blockIndex] ?? "").length;
        const requiredSec = Math.max(1.2, wordCount * 0.18);
        if (visibleUntilSec - at < requiredSec) throw new Error(`${scene.id}: reveal ${blockIndex + 1} has less than ${requiredSec.toFixed(2)} seconds of reading time`);
      });
    }
  });
  return { version: 1, fps: FPS, title: ir.title, aspects: ir.aspects, totalFrames: from, music: ir.music, musicSrc: timings.musicSrc, scenes, chapters };
}
