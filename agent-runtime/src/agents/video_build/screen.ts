/**
 * Does a generated clip contain a shot at all?
 *
 * The notes name video generation as one of two content defects. Until now
 * nothing looked at a generated clip: `persistCompletedClip` checked that the
 * provider answered, that the body was not empty, and that the content type
 * said video, and then stored the bytes as a finished shot. A clip that was
 * black end to end, or a still frame the model never animated, was indexed
 * exactly like a good one. Nobody found out until a person watched the
 * assembled reel, by which point every shot had been paid for.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not judge whether a shot is any good. `video_edit`'s probe exists for
 * a finished reel and holds it to an export contract -- 1080x1920, three to
 * ninety seconds, and ANY black or frozen interval is a defect. Applying that
 * here would be wrong, not merely strict: a generated shot is five seconds, its
 * dimensions come from the provider rather than from our export, and a shot
 * that opens dark or holds a beat is a legitimate choice. Rejecting those would
 * throw away good work and teach people to ignore the screen.
 *
 * So this refuses only what is broken on any reading:
 *
 *   - no decodable video stream
 *   - a duration too short to be a shot
 *   - black from end to end
 *   - frozen from end to end -- the model returned a still
 *
 * Everything between those and "good" is creative judgement, which belongs to
 * the person reviewing the cut and to video_edit's model-led screen. This is
 * the measurable half of the defect, and measurable is all it claims.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  blackIntervalsFromLog,
  coveredFraction,
  freezeIntervalsFromLog,
  type Interval,
} from "../../media/ffmpegLog.js";

const run = promisify(execFile);

/**
 * How much of a clip has to be black, or frozen, before it counts as being so
 * end to end.
 *
 * Not 1.0: blackdetect and freezedetect report whole runs and the last fraction
 * of a second often falls outside one, so an entirely dead clip measures a
 * little under the whole. Not lower either -- at four fifths this would start
 * catching a slow shot that holds, which is a judgement it has no business
 * making.
 */
export const DEAD_CLIP_COVERAGE = 0.95;

/** A shot shorter than this is not a shot, whatever else is true of it. */
export const MIN_CLIP_SECONDS = 1;

export interface GeneratedClipProbe {
  width: number;
  height: number;
  duration_sec: number;
  has_video_stream: boolean;
  black_intervals: Interval[];
  freeze_intervals: Interval[];
}

/**
 * Why this clip cannot be stored as a shot, or null if it can.
 *
 * Pure, so the decision is testable without ffmpeg and without a provider. The
 * wording is what a person reads in the job's event log, so it says what was
 * measured rather than naming a threshold.
 */
export function generatedClipProblem(probe: GeneratedClipProbe): string | null {
  if (!probe.has_video_stream) {
    return "The generated clip has no video stream, so there is no shot in it.";
  }
  if (!Number.isFinite(probe.duration_sec) || probe.duration_sec < MIN_CLIP_SECONDS) {
    return `The generated clip is ${
      Number.isFinite(probe.duration_sec) ? `${probe.duration_sec}s` : "of unreadable length"
    }, which is too short to be a shot.`;
  }
  const black = coveredFraction(probe.black_intervals, probe.duration_sec);
  if (black >= DEAD_CLIP_COVERAGE) {
    return `The generated clip is black for the whole of its ${probe.duration_sec}s, so nothing was rendered.`;
  }
  const frozen = coveredFraction(probe.freeze_intervals, probe.duration_sec);
  if (frozen >= DEAD_CLIP_COVERAGE) {
    return `The generated clip does not move for the whole of its ${probe.duration_sec}s: the model returned a still image rather than a shot.`;
  }
  return null;
}

/**
 * Measure a generated clip on disk.
 *
 * Reports what it found and judges nothing -- `generatedClipProblem` decides.
 * Splitting them is what lets the judgement be tested against probes that would
 * be slow, expensive or impossible to produce for real.
 */
export async function probeGeneratedClip(path: string): Promise<GeneratedClipProbe> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration",
    "-of", "json", path,
  ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
    format?: { duration?: string };
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const duration = Number(parsed.format?.duration);

  // Same detector settings video_edit uses, so the two agents measure the same
  // thing and only differ in what they accept.
  const { stderr } = await run("ffmpeg", [
    "-hide_banner", "-nostats", "-i", path,
    "-vf", "blackdetect=d=0.15:pix_th=0.10,freezedetect=n=-55dB:d=2",
    "-an", "-f", "null", "-",
  ], { timeout: 2 * 60_000, maxBuffer: 4 * 1024 * 1024 });

  return {
    width: Number(video?.width ?? 0),
    height: Number(video?.height ?? 0),
    duration_sec: Number.isFinite(duration) ? Number(duration.toFixed(3)) : duration,
    has_video_stream: Boolean(video),
    black_intervals: blackIntervalsFromLog(stderr),
    freeze_intervals: freezeIntervalsFromLog(stderr, duration),
  };
}
