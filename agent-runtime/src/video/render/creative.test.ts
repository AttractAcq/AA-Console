import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseSegmentReport, reviewCodeVideoCandidate, sampleSceneFrames,
  sceneSampleTimes, type Sample } from "./creative.js";

const run = promisify(execFile);

const areas = ["text_overflow", "caption_overlap", "contrast", "safe_area",
  "reading_time", "brand_token", "empty_frame", "narration_visual_match"];

function report(failed?: string) {
  return { result: failed ? "fail" : "pass",
    summary: failed ? `${failed} failed.` : "Checks passed.",
    checks: areas.map((area) => ({ area,
      verdict: area === failed ? "fail" : "pass",
      reason: `${area} examined.`, at_sec: null })) };
}

describe("code-video final creative review", () => {
  it("samples three points within each scene and refuses overlapping timing", () => {
    expect(sceneSampleTimes([{ sceneId: "s01", startSec: 0, durationSec: 2 },
      { sceneId: "s02", startSec: 2, durationSec: 4 }]))
      .toEqual([{ sceneId: "s01", atSec: 0.2 },
        { sceneId: "s01", atSec: 1 }, { sceneId: "s01", atSec: 1.8 },
        { sceneId: "s02", atSec: 2.2 }, { sceneId: "s02", atSec: 4 },
        { sceneId: "s02", atSec: 5.8 }]);
    expect(() => sceneSampleTimes([{ sceneId: "s01", startSec: 0,
      durationSec: 3 }, { sceneId: "s02", startSec: 2, durationSec: 3 }]))
      .toThrow(/overlap/);
  });

  it("extracts actual JPEG frames at scene-bound times from an MP4", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aa-video-creative-fixture-"));
    try {
      const video = join(directory, "fixture.mp4");
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=6",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", video],
      { timeout: 30_000 });
      const frames = await sampleSceneFrames({ path: video,
        workDir: join(directory, "frames"), scenes: [
          { sceneId: "s01", startSec: 0, durationSec: 3 },
          { sceneId: "s02", startSec: 3, durationSec: 3 }] });
      expect(frames.map((frame) => frame.atSec))
        .toEqual([0.2, 1.5, 2.8, 3.2, 4.5, 5.8]);
      expect(frames.every((frame) => frame.jpeg.subarray(0, 2).toString("hex") === "ffd8"))
        .toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("refuses duplicate, incomplete and contradictory model checks", () => {
    const samples: Sample[] = [{ sceneId: "s01", atSec: 1,
      jpeg: Buffer.from("frame") }];
    expect(() => parseSegmentReport({ ...report(), checks: [
      ...report().checks.slice(0, 7), report().checks[0]] }, samples))
      .toThrow(/duplicate area/);
    expect(() => parseSegmentReport({ ...report(), checks: [] }, samples))
      .toThrow(/omitted/);
    expect(() => parseSegmentReport({ ...report(), result: "fail" }, samples))
      .toThrow(/disagrees/);
  });

  it("batches scene frames and fails the final verdict if one batch fails", async () => {
    const scenes = Array.from({ length: 14 }, (_, index) => ({
      sceneId: `s${String(index + 1).padStart(2, "0")}`,
      startSec: index * 3, durationSec: 3 }));
    const sample = vi.fn(async () => sceneSampleTimes(scenes).map((point) => ({
      ...point, jpeg: Buffer.from("frame") })));
    const complete = vi.fn()
      .mockResolvedValueOnce({ raw: report("contrast"), model: "model-x",
        usage: { inputTokens: 100, outputTokens: 20,
          cacheReadTokens: 0, cacheWriteTokens: 0 } })
      .mockResolvedValueOnce({ raw: report(), model: "model-x",
        usage: { inputTokens: 50, outputTokens: 10,
          cacheReadTokens: 0, cacheWriteTokens: 0 } });
    const reviewed = await reviewCodeVideoCandidate({ path: "/tmp/video.mp4",
      workDir: "/tmp/frames", scenes, narration: "Narration",
      brandRules: "Blue only", model: "claude-sonnet-4-5", apiKey: "test" },
    { sample, complete });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(reviewed).toMatchObject({ result: "fail", sampled_frames: 42,
      usage: { inputTokens: 150, outputTokens: 30 } });
    expect(reviewed.checks).toHaveLength(8);
    expect(reviewed.checks.find((check) => check.area === "contrast")?.verdict)
      .toBe("fail");
    expect(reviewed.segments).toHaveLength(2);
  });
});
