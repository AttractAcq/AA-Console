import { describe, expect, it } from "vitest";

import { coveredFraction } from "../../media/ffmpegLog.js";
import {
  DEAD_CLIP_COVERAGE,
  generatedClipProblem,
  type GeneratedClipProbe,
} from "./screen.js";

/**
 * The screen's whole value is in where it draws the line, so that is what these
 * test: a clip that is dead end to end is refused, and a clip that merely opens
 * dark or holds a beat is not. The second half matters as much as the first --
 * a screen that rejected good shots would be worse than none, because people
 * would learn to work around it.
 */
const probe = (over: Partial<GeneratedClipProbe> = {}): GeneratedClipProbe => ({
  width: 1080,
  height: 1920,
  duration_sec: 5,
  has_video_stream: true,
  black_intervals: [],
  freeze_intervals: [],
  ...over,
});

describe("what the screen refuses", () => {
  it("refuses a file with no video stream", () => {
    expect(generatedClipProblem(probe({ has_video_stream: false })))
      .toMatch(/no video stream/);
  });

  it("refuses a clip too short to be a shot", () => {
    expect(generatedClipProblem(probe({ duration_sec: 0.4 })))
      .toMatch(/0\.4s, which is too short/);
  });

  it("refuses a clip of unreadable length, without inventing a number", () => {
    expect(generatedClipProblem(probe({ duration_sec: NaN })))
      .toMatch(/unreadable length/);
  });

  it("refuses a clip that is black end to end", () => {
    expect(generatedClipProblem(probe({
      black_intervals: [{ start_sec: 0, end_sec: 5 }],
    }))).toMatch(/black for the whole/);
  });

  it("refuses a still the model never animated", () => {
    // The defect in its purest form: a 'video' that does not move.
    expect(generatedClipProblem(probe({
      freeze_intervals: [{ start_sec: 0, end_sec: 5 }],
    }))).toMatch(/returned a still image rather than a shot/);
  });
});

describe("what the screen leaves alone, on purpose", () => {
  it("passes a good clip", () => {
    expect(generatedClipProblem(probe())).toBeNull();
  });

  it("passes a shot that opens dark", () => {
    // video_edit fails ANY black interval, because a finished reel should not
    // have one. A generated shot may legitimately fade up, and rejecting that
    // would throw away good work.
    expect(generatedClipProblem(probe({
      black_intervals: [{ start_sec: 0, end_sec: 0.8 }],
    }))).toBeNull();
  });

  it("passes a shot that holds a beat", () => {
    expect(generatedClipProblem(probe({
      freeze_intervals: [{ start_sec: 3, end_sec: 5 }],
    }))).toBeNull();
  });

  it("passes a shot that is mostly still but not entirely", () => {
    // Deliberately just under the line. Whether a shot this static is any good
    // is creative judgement, and this screen does not make it.
    expect(generatedClipProblem(probe({
      duration_sec: 10,
      freeze_intervals: [{ start_sec: 0, end_sec: 9 }],
    }))).toBeNull();
  });

  it("says nothing about dimensions, which come from the provider", () => {
    // 1080x1920 is video_edit's export contract, not a generated shot's.
    expect(generatedClipProblem(probe({ width: 1280, height: 720 }))).toBeNull();
  });
});

describe("measuring how much of a clip an interval set covers", () => {
  it("adds separate runs up", () => {
    expect(coveredFraction([
      { start_sec: 0, end_sec: 1 },
      { start_sec: 3, end_sec: 4 },
    ], 10)).toBeCloseTo(0.2);
  });

  it("counts overlapping runs once", () => {
    // Two reports of the same second must not add up to two seconds, or a clip
    // could measure as more than entirely black.
    expect(coveredFraction([
      { start_sec: 0, end_sec: 4 },
      { start_sec: 2, end_sec: 5 },
    ], 10)).toBeCloseTo(0.5);
  });

  it("never exceeds the whole clip", () => {
    expect(coveredFraction([{ start_sec: 0, end_sec: 99 }], 5)).toBe(1);
  });

  it("answers nothing for a duration it cannot use", () => {
    // Not 1: a clip of unreadable length is refused for being unreadable, by
    // the duration rule, rather than reported as black.
    expect(coveredFraction([{ start_sec: 0, end_sec: 5 }], NaN)).toBe(0);
    expect(coveredFraction([{ start_sec: 0, end_sec: 5 }], 0)).toBe(0);
  });

  it("ignores a run that ends before it starts", () => {
    expect(coveredFraction([{ start_sec: 4, end_sec: 2 }], 10)).toBe(0);
  });

  it("treats the threshold as reachable by a real dead clip", () => {
    // A 5s clip whose detector run stops a hundredth short still counts.
    expect(coveredFraction([{ start_sec: 0, end_sec: 4.99 }], 5))
      .toBeGreaterThanOrEqual(DEAD_CLIP_COVERAGE);
  });
});
