/**
 * EDL to ffmpeg arguments.
 *
 * Pure: this builds an argv and the caption files it reads, and runs nothing.
 * media.ts runs it with execFile, so no shell ever parses a value.
 *
 * Caption text never enters the filtergraph. Each caption goes to its own
 * file and drawtext reads it with textfile= and expansion=none. Inline text
 * would need three layers of escaping (drawtext, filtergraph, option), and a
 * model-written apostrophe or colon would break the render or the filter.
 *
 * Output is 1080x1920, 30 fps, H.264, faststart: what Reels and TikTok take.
 * Clips are scaled to fill and centre-cropped, not letterboxed. Generated
 * shots are already 9:16, so the crop is a no-op for them.
 *
 * Every link that feeds a join carries OUTPUT_TB. xfade refuses two inputs
 * whose timebases differ, and concat rewrites its output to AV_TIME_BASE_Q
 * (1/1000000) whatever it was given. So a cut followed by a crossfade handed
 * xfade one link at 1/1000000 and one at 1/30, and the render died with
 * "Failed to configure output pad" and "-22 (Invalid argument)". A settb
 * after every concat, and on every segment, makes the timebases agree by
 * construction instead of by the order the model happened to choose.
 */

import {
  CROSSFADE_SEC,
  segmentsDuration,
  segmentWindows,
  totalDuration,
  type CaptionPosition,
  type Edl,
} from "./edl.js";

export const OUTPUT_WIDTH = 1080;
export const OUTPUT_HEIGHT = 1920;
export const OUTPUT_FPS = 30;
/** The one timebase every join input carries. See the note above. */
export const OUTPUT_TB = `1/${OUTPUT_FPS}`;

/** Paths go into the filtergraph unquoted, so they are held to plain characters. */
const SAFE_PATH = /^[A-Za-z0-9_./-]+$/;
const HEX = /^#?([0-9a-f]{6})$/i;

export class RenderPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderPlanError";
  }
}

export interface RenderOptions {
  /** Shot position to a local clip file. */
  clipPaths: ReadonlyMap<number, string>;
  outputPath: string;
  /** A TTF on disk. Alpine has no fontconfig default, so it is always explicit. */
  fontFile: string;
  /** Directory media.ts writes caption files to. */
  workDir: string;
  musicPath?: string | null;
  /** Brand colours. Anything that is not a six-digit hex falls back. */
  backgroundColour?: string | null;
  textColour?: string | null;
}

export interface RenderPlan {
  args: string[];
  /** Write these before running ffmpeg. */
  textFiles: Array<{ path: string; content: string }>;
  durationSec: number;
}

function safePath(value: string, label: string): string {
  if (!SAFE_PATH.test(value) || value.includes("..")) {
    throw new RenderPlanError(`The ${label} path has characters ffmpeg filters cannot take.`);
  }
  return value;
}

function colour(value: string | null | undefined, fallback: string): string {
  const match = value?.trim().match(HEX);
  return `0x${(match?.[1] ?? fallback).toLowerCase()}`;
}

/** Seconds as ffmpeg reads them. Fixed precision so the argv is stable in tests. */
function sec(value: number): string {
  return (Math.round(value * 1000) / 1000).toString();
}

/**
 * drawtext does not wrap. A bold face runs about 0.6 em per character, so at
 * 64px a 1080 frame with margins holds about 24; 22 leaves room for wide
 * glyphs. A word longer than the line is left whole rather than split.
 */
export const CAPTION_LINE_CHARS = 22;
export const END_CARD_LINE_CHARS = 16;

export function wrapText(text: string, lineChars: number): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.trim().split(/\s+/)) {
    if (line && line.length + 1 + word.length > lineChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

function captionY(position: CaptionPosition): string {
  // Bottom sits above the Reels caption and button area, not at the edge.
  if (position === "top") return "h*0.12";
  if (position === "middle") return "(h-text_h)/2";
  return "h*0.70";
}

export function buildRenderPlan(edl: Edl, options: RenderOptions): RenderPlan {
  const fontFile = safePath(options.fontFile, "font");
  const workDir = safePath(options.workDir.replace(/\/+$/, ""), "work directory");
  const background = colour(options.backgroundColour, "000000");
  const textColour = colour(options.textColour, "ffffff");

  const args: string[] = ["-hide_banner", "-loglevel", "error", "-y"];
  const filters: string[] = [];

  // One input per segment, trimmed at the input. Re-encoding makes the
  // input seek frame-accurate, and it keeps each stream starting at zero.
  edl.segments.forEach((segment, i) => {
    const path = options.clipPaths.get(segment.shot);
    if (!path) throw new RenderPlanError(`Shot ${segment.shot} has no clip file.`);
    args.push("-ss", sec(segment.in_sec), "-t", sec(segment.out_sec - segment.in_sec), "-i", path);
    filters.push(
      `[${i}:v]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,` +
        `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},setsar=1,fps=${OUTPUT_FPS},format=yuv420p,` +
        `setpts=PTS-STARTPTS,settb=${OUTPUT_TB}[s${i}]`,
    );
  });

  // An xfade starts where its own segment starts on the timeline, which is
  // what segmentWindows works out. validateEdl reads the same windows.
  const windows = segmentWindows(edl.segments);
  let current = "s0";
  for (let i = 1; i < edl.segments.length; i += 1) {
    const next = `j${i}`;
    if (edl.segments[i]!.transition === "crossfade") {
      filters.push(
        `[${current}][s${i}]xfade=transition=fade:duration=${sec(CROSSFADE_SEC)}:offset=${sec(windows[i]!.start)}[${next}]`,
      );
    } else {
      filters.push(`[${current}][s${i}]concat=n=2:v=1:a=0,settb=${OUTPUT_TB}[${next}]`);
    }
    current = next;
  }

  let inputCount = edl.segments.length;
  const cutSec = segmentsDuration(edl.segments);
  if (edl.end_card_text) {
    args.push(
      "-f",
      "lavfi",
      "-t",
      sec(edl.end_card_sec),
      "-i",
      `color=c=${background}:s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:r=${OUTPUT_FPS}`,
    );
    filters.push(`[${inputCount}:v]format=yuv420p,setsar=1[card]`);
    filters.push(`[${current}][card]concat=n=2:v=1:a=0,settb=${OUTPUT_TB}[withcard]`);
    current = "withcard";
    inputCount += 1;
  }

  const textFiles: RenderPlan["textFiles"] = [];
  const drawText = (file: string, y: string, size: number, start: number, end: number) =>
    `drawtext=fontfile=${fontFile}:textfile=${file}:expansion=none:fontsize=${size}:line_spacing=12:` +
    `fontcolor=${textColour}:borderw=5:bordercolor=black@0.85:x=(w-text_w)/2:y=${y}:` +
    `enable='between(t,${sec(start)},${sec(end)})'`;

  const overlays: string[] = [];
  edl.captions.forEach((caption, i) => {
    const file = `${workDir}/caption-${i + 1}.txt`;
    textFiles.push({ path: file, content: wrapText(caption.text, CAPTION_LINE_CHARS) });
    overlays.push(drawText(file, captionY(caption.position), 64, caption.start_sec, caption.end_sec));
  });
  if (edl.end_card_text) {
    const file = `${workDir}/end-card.txt`;
    textFiles.push({ path: file, content: wrapText(edl.end_card_text, END_CARD_LINE_CHARS) });
    overlays.push(drawText(file, "(h-text_h)/2", 80, cutSec, cutSec + edl.end_card_sec));
  }
  filters.push(`[${current}]${overlays.length ? overlays.join(",") : "null"}[vout]`);

  const durationSec = totalDuration(edl);
  const audioMaps: string[] = ["-an"];
  if (options.musicPath) {
    args.push("-i", options.musicPath);
    const fadeStart = Math.max(0, durationSec - 1);
    filters.push(
      `[${inputCount}:a]atrim=0:${sec(durationSec)},asetpts=PTS-STARTPTS,afade=t=out:st=${sec(fadeStart)}:d=1[aout]`,
    );
    audioMaps.splice(0, 1, "-map", "[aout]", "-c:a", "aac", "-b:a", "128k");
  }

  args.push("-filter_complex", filters.join(";"), "-map", "[vout]", ...audioMaps);
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(OUTPUT_FPS),
    "-movflags",
    "+faststart",
    "-t",
    sec(durationSec),
    options.outputPath,
  );
  return { args, textFiles, durationSec };
}
