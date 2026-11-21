import { describe, expect, it } from "vitest";
import { assessProjectRender } from "./probe.js";

const clean = { aspect: "16:9" as const, width: 1920, height: 1080,
  durationSec: 60, expectedDurationSec: 60, hasAudio: true,
  audioIntegratedLufs: -14, audioTruePeakDbfs: -1.6,
  blackIntervals: [], freezeIntervals: [] };

describe("project export physical probe", () => {
  it("accepts the requested aspect with timed, mastered audio", () => {
    expect(assessProjectRender(clean)).toMatchObject({ result: "pass",
      width: 1920, height: 1080, duration_sec: 60, checks: [] });
    expect(assessProjectRender({ ...clean, aspect: "9:16",
      width: 1080, height: 1920 }).result).toBe("pass");
    expect(assessProjectRender({ ...clean, aspect: "1:1",
      width: 1080, height: 1080 }).result).toBe("pass");
  });

  it("holds a wrong aspect, timing drift or missing audio", () => {
    const result = assessProjectRender({ ...clean, aspect: "9:16",
      durationSec: 61, hasAudio: false });
    expect(result.result).toBe("fail");
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.stringContaining("Expected 1080x1920"),
      expect.stringContaining("differs from the approved scene timing"),
      expect.stringContaining("Narration audio is missing"),
    ]));
  });

  it("holds unmastered audio and black or frozen frames", () => {
    const result = assessProjectRender({ ...clean,
      audioIntegratedLufs: -24, audioTruePeakDbfs: -0.4,
      blackIntervals: [{ start_sec: 1, end_sec: 2 }],
      freezeIntervals: [{ start_sec: 5, end_sec: 8 }] });
    expect(result.result).toBe("fail");
    expect(result.checks).toHaveLength(4);
  });
});
