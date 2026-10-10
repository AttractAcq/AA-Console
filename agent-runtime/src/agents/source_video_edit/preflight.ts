import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatFfmpegStderr } from "../video_edit/media.js";

const run = promisify(execFile);

/** Check renderer support before transcription or Claude is charged. */
export async function sourceEditCapability(needsText: boolean): Promise<string | null> {
  try {
    const [{ stdout: filters }, { stdout: encoders }] = await Promise.all([
      run("ffmpeg", ["-hide_banner", "-filters"], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }),
      run("ffmpeg", ["-hide_banner", "-encoders"], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }),
    ]);
    const required = ["scale", "crop", "concat", "aresample", ...(needsText ? ["drawtext"] : [])];
    const missing = required.filter((name) => !new RegExp(`\\b${name}\\b`).test(filters));
    if (!/\blibx264\b/.test(encoders)) missing.push("libx264 encoder");
    return missing.length ? `This FFmpeg cannot render the edit: missing ${missing.join(", ")}.` : null;
  } catch (error) {
    return `FFmpeg is unavailable: ${formatFfmpegStderr(error)}`;
  }
}
