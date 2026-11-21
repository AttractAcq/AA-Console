import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { blackIntervalsFromLog, freezeIntervalsFromLog } from "../../media/ffmpegLog.js";

const run = promisify(execFile);
export type VideoAspect = "16:9" | "9:16" | "1:1";
export type ProjectRenderProbe = {
  result: "pass" | "fail";
  width: number;
  height: number;
  duration_sec: number;
  has_audio: boolean;
  audio_integrated_lufs: number | null;
  audio_true_peak_dbfs: number | null;
  black_intervals: Array<{ start_sec: number; end_sec: number }>;
  freeze_intervals: Array<{ start_sec: number; end_sec: number }>;
  checks: string[];
};

const dimensions: Record<VideoAspect, readonly [number, number]> = {
  "16:9": [1920, 1080], "9:16": [1080, 1920], "1:1": [1080, 1080],
};

function lastNumber(log: string, expression: RegExp): number | null {
  const matches = [...log.matchAll(expression)];
  const value = Number(matches.at(-1)?.[1]);
  return Number.isFinite(value) ? value : null;
}

/** Physical export checks. Creative quality and owner approval have separate gates. */
export function assessProjectRender(input: {
  aspect: VideoAspect; width: number; height: number; durationSec: number;
  hasAudio: boolean; audioIntegratedLufs: number | null;
  audioTruePeakDbfs: number | null;
  blackIntervals: Array<{ start_sec: number; end_sec: number }>;
  freezeIntervals: Array<{ start_sec: number; end_sec: number }>;
  expectedDurationSec?: number;
}): ProjectRenderProbe {
  const [expectedWidth, expectedHeight] = dimensions[input.aspect];
  const checks: string[] = [];
  if (input.width !== expectedWidth || input.height !== expectedHeight) {
    checks.push(`Expected ${expectedWidth}x${expectedHeight}; got ${input.width}x${input.height}.`);
  }
  if (!Number.isFinite(input.durationSec) || input.durationSec < 20
    || input.durationSec > 960) checks.push("Export duration is outside 20–960 seconds.");
  if (input.expectedDurationSec !== undefined
    && (!Number.isFinite(input.expectedDurationSec)
      || Math.abs(input.durationSec - input.expectedDurationSec) > 0.5)) {
    checks.push("Export duration differs from the approved scene timing.");
  }
  if (!input.hasAudio) checks.push("Narration audio is missing.");
  if (input.hasAudio && (input.audioIntegratedLufs === null
    || Math.abs(input.audioIntegratedLufs + 14) > 1.5)) {
    checks.push("Integrated loudness is outside -14 ±1.5 LUFS.");
  }
  if (input.hasAudio && (input.audioTruePeakDbfs === null
    || input.audioTruePeakDbfs > -1.5)) {
    checks.push("True peak exceeds -1.5 dBFS or could not be measured.");
  }
  if (input.blackIntervals.length) checks.push("Black intervals detected.");
  if (input.freezeIntervals.length) checks.push("Frozen intervals detected.");
  return {
    result: checks.length ? "fail" : "pass",
    width: input.width, height: input.height,
    duration_sec: Number.isFinite(input.durationSec)
      ? Number(input.durationSec.toFixed(3)) : 0,
    has_audio: input.hasAudio,
    audio_integrated_lufs: input.audioIntegratedLufs,
    audio_true_peak_dbfs: input.audioTruePeakDbfs,
    black_intervals: input.blackIntervals,
    freeze_intervals: input.freezeIntervals,
    checks,
  };
}

/** Probe the downloaded, mastered MP4 bytes before they become a candidate. */
export async function probeProjectRender(input: { path: string;
  aspect: VideoAspect; expectedDurationSec?: number }): Promise<ProjectRenderProbe> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries",
    "stream=codec_type,width,height:format=duration", "-of", "json", input.path],
  { timeout: 30_000, maxBuffer: 1024 * 1024 });
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
    format?: { duration?: string };
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const duration = Number(parsed.format?.duration);
  const hasAudio = Boolean(parsed.streams?.some((stream) => stream.codec_type === "audio"));
  const visual = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", input.path,
    "-vf", "blackdetect=d=0.15:pix_th=0.10,freezedetect=n=-55dB:d=2",
    "-an", "-f", "null", "-"], { timeout: 20 * 60_000, maxBuffer: 8 * 1024 * 1024 });
  let integrated: number | null = null;
  let truePeak: number | null = null;
  if (hasAudio) {
    const audio = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", input.path,
      "-vn", "-filter_complex", "ebur128=peak=true", "-f", "null", "-"],
    { timeout: 20 * 60_000, maxBuffer: 8 * 1024 * 1024 });
    integrated = lastNumber(audio.stderr, /^\s*I:\s*(-?\d+(?:\.\d+)?) LUFS\s*$/gm);
    truePeak = lastNumber(audio.stderr, /^\s*Peak:\s*(-?\d+(?:\.\d+)?) dBFS\s*$/gm);
  }
  return assessProjectRender({ aspect: input.aspect,
    width: Number(video?.width ?? 0), height: Number(video?.height ?? 0),
    durationSec: duration, hasAudio,
    audioIntegratedLufs: integrated, audioTruePeakDbfs: truePeak,
    blackIntervals: blackIntervalsFromLog(visual.stderr),
    freezeIntervals: freezeIntervalsFromLog(visual.stderr, duration),
    expectedDurationSec: input.expectedDurationSec });
}
