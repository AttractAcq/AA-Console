/**
 * The only module here that runs ffmpeg or ffprobe.
 *
 * execFile, never a shell: every argument arrives as one argv entry, so a
 * path or caption cannot become a second command. The runtime image does not
 * ship ffmpeg yet; this spike runs where it is installed.
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
 * This used to keep the last three lines. ffmpeg reports the actual fault
 * near the top — "No such filter", "Error initializing filter", "Invalid
 * argument" against a specific option — and then prints a generic tail about
 * the encoder and the empty output file. So the three lines kept were the
 * three least useful ones, and the first real cut failed with
 * "Task finished with error code: -22" and "Nothing was written into output
 * file", neither of which names a cause.
 *
 * Now the diagnosis comes first: the lines that look like the error, then the
 * tail for context. Capped so a job event stays readable.
 */
const ERROR_LINE = /no such filter|error (initializing|while|opening|applying)|invalid|unable to|failed to|unrecognized|cannot/i;

export function formatFfmpegStderr(error: unknown): string {
  const stderr = (error as { stderr?: unknown })?.stderr;
  const text = typeof stderr === "string" ? stderr.trim() : "";
  if (!text) return error instanceof Error ? error.message : String(error);

  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const diagnostic = lines.filter((line) => ERROR_LINE.test(line)).slice(0, 4);
  const tail = lines.slice(-2);
  const kept = [...diagnostic, ...tail.filter((line) => !diagnostic.includes(line))];
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
