import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatFfmpegStderr } from "../video_edit/media.js";

const run = promisify(execFile);

/** Frame-accurate source cut with the original audio transcoded into the MP4. */
export async function extractRepurposeClip(input: string, output: string,
  startSec: number, endSec: number): Promise<void> {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0
    || endSec - startSec < 8 || endSec - startSec > 60) {
    throw new Error("The clip range must be 8 to 60 seconds inside the source.");
  }
  try {
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
      "-ss", String(startSec), "-i", input, "-t", String(endSec - startSec),
      "-map", "0:v:0", "-map", "0:a:0", "-c:v", "libx264", "-preset", "veryfast",
      "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart", output], { timeout: 5 * 60_000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`Could not extract the source clip: ${formatFfmpegStderr(error)}`);
  }
}
