/**
 * Reading ffmpeg's blackdetect and freezedetect output.
 *
 * Two agents need this and they need it for different reasons, which is why it
 * lives here rather than in either of them. video_edit probes a finished reel
 * against an export contract -- 1080x1920, three to ninety seconds, and any
 * black or frozen interval at all is a defect. video_build probes a five-second
 * generated shot, where a dark opening is a legitimate choice and only a clip
 * that is black or frozen END TO END says the generation failed.
 *
 * The parsing is the same either way; the judgement is not. Keeping one parser
 * and two judgements is the point: a second copy of this would drift from the
 * first the moment ffmpeg changed its log format.
 */

export interface Interval {
  start_sec: number;
  end_sec: number;
}

/** Black runs, as `blackdetect` reports them. */
export function blackIntervalsFromLog(log: string): Interval[] {
  return [...log.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)]
    .map((match) => ({ start_sec: Number(match[1]), end_sec: Number(match[2]) }))
    .filter((interval) => Number.isFinite(interval.start_sec) && Number.isFinite(interval.end_sec));
}

/**
 * Frozen runs, as `freezedetect` reports them.
 *
 * A freeze that is still going when the file ends has a start and no end, so
 * the clip's duration closes it. Runs shorter than two seconds are dropped:
 * freezedetect is configured with `d=2`, so anything shorter is noise rather
 * than a report.
 */
export function freezeIntervalsFromLog(log: string, durationSec: number): Interval[] {
  const starts = [...log.matchAll(/freeze_start:\s*([\d.]+)/g)]
    .map((match) => Number(match[1]));
  const ends = [...log.matchAll(/freeze_end:\s*([\d.]+)/g)]
    .map((match) => Number(match[1]));
  return starts.map((start, index) => ({
    start_sec: start,
    end_sec: ends[index] ?? durationSec,
  })).filter((interval) => Number.isFinite(interval.start_sec)
    && Number.isFinite(interval.end_sec)
    && interval.end_sec - interval.start_sec >= 2);
}

/**
 * How much of a clip these intervals cover, as a fraction of its duration.
 *
 * Overlapping intervals are merged first, so two reports of the same second
 * cannot add up to more than that second. Returns 0 for a duration that is not
 * a usable number, because "what fraction of nothing" has no answer and
 * guessing 1 would reject a clip for being unreadable rather than for being
 * black.
 */
export function coveredFraction(intervals: readonly Interval[], durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  const sorted = [...intervals]
    .filter((i) => i.end_sec > i.start_sec)
    .sort((a, b) => a.start_sec - b.start_sec);
  let covered = 0;
  let cursor = -Infinity;
  for (const interval of sorted) {
    const start = Math.max(interval.start_sec, cursor);
    if (interval.end_sec > start) {
      covered += interval.end_sec - start;
      cursor = interval.end_sec;
    }
  }
  return Math.min(1, covered / durationSec);
}
