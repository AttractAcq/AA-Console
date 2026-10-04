/**
 * The only module here that runs ffmpeg or ffprobe.
 *
 * execFile, never a shell: every argument arrives as one argv entry, so a
 * path or caption cannot become a second command. The runtime image installs
 * ffmpeg; renderCapability checks it can do the filters a cut needs before
 * anything is planned or paid for.
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { RenderPlan } from "./render.js";

const run = promisify(execFile);

/** A 30s reel renders in well under this on one core. */
const RENDER_TIMEOUT_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 30_000;

export class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaError";
  }
}

/**
 * The part of ffmpeg's stderr that says what went wrong.
 *
 * Two wrong answers preceded this one. Keeping the last three lines kept
 * ffmpeg's generic tail about the encoder and the empty output file, so the
 * first real cut failed with "Task finished with error code: -22" and
 * "Nothing was written into output file", neither of which names a cause.
 * Keeping the lines that match error-ish words then dropped the one line
 * that mattered: a cut followed by a crossfade reported "Failed to configure
 * output pad on Parsed_xfade_38", while the line above it —
 * "First input link main timebase (1/1000000) do not match ... (1/30)" —
 * has no such word in it and was filtered out as noise. It was the whole
 * diagnosis.
 *
 * So the head is kept unconditionally. Every call here runs ffmpeg at
 * -loglevel error, where every line is already an error and the cause comes
 * first, so the first few lines are the diagnosis whether or not they
 * contain a word a regex likes. Keywords still have a use, but only to pull
 * a cause forward from under a banner — additively, never as the filter that
 * decides what survives. That distinction is the whole of the second bug.
 */
const HEAD_LINES = 6;
const TAIL_LINES = 2;
/** Only ever used to pull a cause forward, never to discard a line. */
const CAUSE_LINE = /no such filter|error (initializing|reinitializing|while|opening|applying)|do not match|unable to|unrecognized option|invalid argument for/i;
/** Version and stream chatter: the only lines that never carry a cause. */
const BANNER_LINE = /^(ffmpeg version|built with|\s*configuration:|\s*lib(av|sw|post)\w*\s|\s*Stream #|\s*Metadata:|\s*encoder\s*:|Input #|Output #)/i;

/**
 * Whether this ffmpeg can actually render a cut, checked before paying for one.
 *
 * The render burns captions with drawtext, which is a build-time option.
 * Homebrew's default build omits it and the tests had to learn to check for
 * the filter rather than the binary; the same question applies to whatever
 * ffmpeg the container ships. Asking afterwards means discovering it after a
 * plan has been written and paid for, with an error that says "Invalid
 * argument" rather than "this ffmpeg cannot do captions".
 *
 * Cheap: one ffmpeg -filters, no media touched.
 */
export async function renderCapability(): Promise<{ ok: true } | { ok: false; message: string }> {
  let filters: string;
  try {
    const result = await run("ffmpeg", ["-hide_banner", "-filters"], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
    filters = result.stdout;
  } catch (error) {
    return {
      ok: false,
      message: `ffmpeg is not usable on this runtime: ${formatFfmpegStderr(error)}`,
    };
  }
  const missing = ["drawtext", "xfade", "scale"].filter((filter) => !new RegExp(`\\b${filter}\\b`).test(filters));
  if (missing.length > 0) {
    return {
      ok: false,
      message:
        `This ffmpeg has no ${missing.join(", ")} filter, so a cut cannot be rendered. ` +
        `drawtext needs a build with libfreetype. Nothing was planned, so nothing was spent.`,
    };
  }
  return { ok: true };
}

export function formatFfmpegStderr(error: unknown): string {
  const stderr = (error as { stderr?: unknown })?.stderr;
  const text = typeof stderr === "string" ? stderr.trim() : "";
  if (!text) return error instanceof Error ? error.message : String(error);

  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  // Drop version and stream chatter: the one thing ffmpeg prints that never
  // carries a cause. If that leaves nothing, keep what there was.
  const meaningful = lines.filter((line) => !BANNER_LINE.test(line));
  const body = meaningful.length > 0 ? meaningful : lines;

  const head = body.slice(0, HEAD_LINES);
  const kept = [...head];
  const add = (line: string) => {
    if (!kept.includes(line)) kept.push(line);
  };
  // Additive, not selective: a cause pushed past the head by a banner still
  // gets in, and a cause with no keyword is already in the head.
  for (const line of body.filter((line) => CAUSE_LINE.test(line)).slice(0, 2)) add(line);
  for (const line of body.slice(-TAIL_LINES)) add(line);
  return kept.join(" | ").slice(0, 1500);
}

export async function probeDurationSec(path: string): Promise<number> {
  try {
    const { stdout } = await run(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path],
      { timeout: PROBE_TIMEOUT_MS },
    );
    const duration = Number.parseFloat(stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0) throw new MediaError(`${path} has no readable duration.`);
    return duration;
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new MediaError(`Could not probe ${path}: ${formatFfmpegStderr(error)}`);
  }
}

/**
 * Stills the planner looks at. The model never sees video: it sees these,
 * labelled with their time inside the clip, so it can name in/out points.
 */
export async function sampleFrames(
  clipPath: string,
  outDir: string,
  options: { fps: number; width: number },
): Promise<Array<{ atSec: number; jpeg: Buffer }>> {
  await mkdir(outDir, { recursive: true });
  try {
    await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        clipPath,
        "-vf",
        `fps=${options.fps},scale=${options.width}:-2`,
        "-q:v",
        "4",
        join(outDir, "frame-%04d.jpg"),
      ],
      { timeout: RENDER_TIMEOUT_MS },
    );
  } catch (error) {
    throw new MediaError(`Could not sample frames from ${clipPath}: ${formatFfmpegStderr(error)}`);
  }
  const files = (await readdir(outDir)).filter((name) => /^frame-\d+\.jpg$/.test(name)).sort();
  return Promise.all(
    files.map(async (name, i) => ({
      // The fps filter emits frame n at roughly n / fps.
      atSec: Math.round((i / options.fps) * 100) / 100,
      jpeg: await readFile(join(outDir, name)),
    })),
  );
}

export async function render(plan: RenderPlan): Promise<void> {
  for (const file of plan.textFiles) await writeFile(file.path, file.content, "utf8");
  try {
    await run("ffmpeg", plan.args, { timeout: RENDER_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    throw new MediaError(`ffmpeg failed: ${formatFfmpegStderr(error)}`);
  }
}
