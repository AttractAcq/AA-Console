import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const target = "I=-14:TP=-1.5:LRA=11";
type Measurement = { input_i: string; input_tp: string;
  input_lra: string; input_thresh: string; target_offset: string };

function measurementFromLog(log: string): Measurement {
  const blocks = [...log.matchAll(/\{\s*"input_i"\s*:[\s\S]*?\}/g)];
  const value = blocks.at(-1)?.[0];
  if (!value) throw new Error("First-pass loudness measurement is missing.");
  const parsed = JSON.parse(value) as Partial<Measurement>;
  for (const key of ["input_i", "input_tp", "input_lra",
    "input_thresh", "target_offset"] as const) {
    if (typeof parsed[key] !== "string"
      || !Number.isFinite(Number(parsed[key]))
      || Math.abs(Number(parsed[key])) > 200) {
      throw new Error(`First-pass loudness ${key} is invalid.`);
    }
  }
  return parsed as Measurement;
}

/** Normalize Lambda's downloaded MP4. Video is stream-copied; only audio is
 * re-encoded. The original downloaded file remains available for inspection.
 */
export async function masterProjectRender(input: {
  sourcePath: string; outputPath: string;
}): Promise<{ outputPath: string; fileBytes: number }> {
  if (!input.sourcePath || !input.outputPath
    || input.sourcePath === input.outputPath
    || !input.outputPath.endsWith(".mp4")) {
    throw new Error("Render master needs distinct MP4 source and output paths.");
  }
  const first = await run("ffmpeg", ["-hide_banner", "-nostats", "-i",
    input.sourcePath, "-vn", "-af", `loudnorm=${target}:print_format=json`,
    "-f", "null", "-"],
  { timeout: 20 * 60_000, maxBuffer: 8 * 1024 * 1024 });
  const measured = measurementFromLog(first.stderr);
  const filter = `loudnorm=${target}:measured_I=${measured.input_i}`
    + `:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}`
    + `:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}`
    + ":linear=true:print_format=json";
  await run("ffmpeg", ["-hide_banner", "-nostats", "-y", "-i", input.sourcePath,
    "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-c:a", "aac",
    "-b:a", "192k", "-ar", "48000", "-af", filter,
    "-movflags", "+faststart", input.outputPath],
  { timeout: 20 * 60_000, maxBuffer: 8 * 1024 * 1024 });
  const file = await stat(input.outputPath);
  if (!file.isFile() || file.size <= 100) {
    throw new Error("Mastered render has no usable MP4 bytes.");
  }
  return { outputPath: input.outputPath, fileBytes: file.size };
}
