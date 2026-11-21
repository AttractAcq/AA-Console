import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const TIMEOUT_MS = 180_000;
const MAX_BUFFER = 2 * 1024 * 1024;

type Loudness = { integratedLufs: number; truePeakDb: number;
  loudnessRangeLu: number; thresholdLufs: number; offsetLu: number };

function finite(value: unknown, name: string): number {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) {
    throw new Error(`Audio loudness ${name} is unavailable.`);
  }
  return number;
}

function parseLoudnorm(stderr: string): Loudness {
  const matches = stderr.match(/\{\s*"input_i"\s*:[^}]+\}/g);
  const latest = matches?.at(-1);
  if (!latest) throw new Error("FFmpeg did not return a loudness measurement.");
  let value: unknown;
  try { value = JSON.parse(latest); }
  catch { throw new Error("FFmpeg returned malformed loudness data."); }
  const row = value as Record<string, unknown>;
  return { integratedLufs: finite(row.input_i, "integrated level"),
    truePeakDb: finite(row.input_tp, "true peak"),
    loudnessRangeLu: finite(row.input_lra, "range"),
    thresholdLufs: finite(row.input_thresh, "threshold"),
    offsetLu: finite(row.target_offset, "offset") };
}

function target(value: number): void {
  if (!Number.isFinite(value) || value < -30 || value > -10) {
    throw new Error("Audio target must be between -30 and -10 LUFS.");
  }
}

export async function measureLufs(path: string, targetLufs = -16): Promise<Loudness> {
  target(targetLufs);
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "info",
    "-i", path, "-af", `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11:print_format=json`,
    "-f", "null", "-"], { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
  return parseLoudnorm(stderr);
}

async function leadingSilenceEndSec(path: string, thresholdSec: number): Promise<number | null> {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "info",
    "-i", path, "-af", `silencedetect=noise=-50dB:d=${thresholdSec}`,
    "-f", "null", "-"], { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
  const start = stderr.match(/silence_start:\s*([\d.]+)/);
  const end = stderr.match(/silence_end:\s*([\d.]+)/);
  if (!start || !end || Number(start[1]) > 0.04) return null;
  const seconds = Number(end[1]);
  return Number.isFinite(seconds) && seconds > thresholdSec ? seconds : null;
}

export async function probeAudioDurationSec(path: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=duration", "-of", "default=noprint_wrappers=1:nokey=1",
    path], { timeout: 30_000, maxBuffer: 64 * 1024 });
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Audio has no decodable positive duration.");
  }
  return duration;
}

export async function normaliseTo(inputPath: string, outputPath: string,
  targetLufs: number, options: { trimLeadingSilenceOverSec?: number;
    padTailSec?: number } = {}): Promise<{ durationSec: number; measuredLufs: number }> {
  target(targetLufs);
  const { trimLeadingSilenceOverSec, padTailSec } = options;
  if ((trimLeadingSilenceOverSec !== undefined && (!Number.isFinite(trimLeadingSilenceOverSec)
      || trimLeadingSilenceOverSec <= 0 || trimLeadingSilenceOverSec > 1))
    || (padTailSec !== undefined && (!Number.isFinite(padTailSec)
      || padTailSec < 0 || padTailSec > 1))) {
    throw new Error("Audio trim and tail settings are invalid.");
  }
  if (inputPath === outputPath || !outputPath.toLowerCase().endsWith(".mp3")) {
    throw new Error("Normalised audio needs a distinct MP3 output path.");
  }
  const leadingEnd = trimLeadingSilenceOverSec === undefined ? null
    : await leadingSilenceEndSec(inputPath, trimLeadingSilenceOverSec);
  if (leadingEnd !== null && leadingEnd >= (await probeAudioDurationSec(inputPath)) - 0.1) {
    throw new Error("Audio is silent after the leading pause.");
  }
  const filters = [
    ...(leadingEnd === null ? [] : [`atrim=start=${leadingEnd}`, "asetpts=PTS-STARTPTS"]),
    ...(padTailSec ? [`apad=pad_dur=${padTailSec}`] : []),
  ];
  const firstPassFilter = [...filters,
    `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11:print_format=json`].join(",");
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "info",
    "-i", inputPath, "-af", firstPassFilter, "-f", "null", "-"],
  { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
  const first = parseLoudnorm(stderr);
  const filter = [`loudnorm=I=${targetLufs}`, "TP=-1.5", "LRA=11",
    `measured_I=${first.integratedLufs}`, `measured_TP=${first.truePeakDb}`,
    `measured_LRA=${first.loudnessRangeLu}`, `measured_thresh=${first.thresholdLufs}`,
    `offset=${first.offsetLu}`, "linear=true", "print_format=json"].join(":");
  const temporary = `${outputPath}.${randomUUID()}.mp3`;
  try {
    await run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-n",
      "-i", inputPath, "-af", [...filters, filter].join(","), "-ar", "44100", "-c:a", "libmp3lame",
      "-q:a", "2", temporary], { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
    // Atomic no-overwrite placement: a concurrent retry cannot silently
    // replace bytes the other attempt already filed at the target path.
    await link(temporary, outputPath);
  } finally { await rm(temporary, { force: true }); }
  if ((await stat(outputPath)).size < 100) throw new Error("Normalised MP3 is empty.");
  const [durationSec, measured] = await Promise.all([
    probeAudioDurationSec(outputPath), measureLufs(outputPath, targetLufs),
  ]);
  if (Math.abs(measured.integratedLufs - targetLufs) > 1) {
    throw new Error("Normalised audio differs from the requested loudness by more than 1 LU.");
  }
  return { durationSec, measuredLufs: measured.integratedLufs };
}
