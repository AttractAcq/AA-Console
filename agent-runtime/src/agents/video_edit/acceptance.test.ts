import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { missingReviewAreas, probeRenderedVideo } from "./acceptance.js";

describe("creative review contract", () => {
  const areas = ["continuity", "visual_defects", "caption_readability", "crop", "narrative", "brand_fit"];
  const check = (area: string) => ({ area, verdict: "pass", reason: "Visible in sampled frames.", at_sec: null });

  it("requires one substantive verdict per area", () => {
    expect(missingReviewAreas({ checks: areas.map(check) })).toEqual([]);
    expect(missingReviewAreas({ checks: [...areas.slice(0, 5).map(check), check("continuity")] }))
      .toEqual(["continuity", "brand_fit"]);
    expect(missingReviewAreas({ checks: areas.map((area) => area === "brand_fit"
      ? { ...check(area), reason: "" } : check(area)) })).toEqual(["brand_fit"]);
  });
});
import { hasAudioStream } from "./media.js";

const run = promisify(execFile);

it("rejects an actual exported file with black frames", async () => {
  const work = await mkdtemp(join(tmpdir(), "video-acceptance-test-"));
  try {
    const path = join(work, "black.mp4");
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
      "-i", "color=c=black:s=1080x1920:r=15:d=3",
      "-c:v", "mpeg4", "-q:v", "8", path,
    ], { timeout: 30_000 });
    const probe = await probeRenderedVideo(path);
    expect(probe.result).toBe("fail");
    expect(probe.width).toBe(1080);
    expect(probe.height).toBe(1920);
    expect(probe.black_intervals.length).toBeGreaterThan(0);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}, 60_000);

it("checks that a requested soundtrack is actually audible in the exported file", async () => {
  const work = await mkdtemp(join(tmpdir(), "video-audio-test-"));
  try {
    const silent = join(work, "silent.mp4");
    const withTone = join(work, "tone.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=blue:s=360x640:r=15:d=3",
      "-c:v", "mpeg4", silent], { timeout: 30_000 });
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
      "-i", silent, "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-c:v", "copy", "-c:a", "aac", "-shortest", withTone], { timeout: 30_000 });
    const missing = await probeRenderedVideo(silent, true);
    const audible = await probeRenderedVideo(withTone, true);
    expect(await hasAudioStream(silent)).toBe(false);
    expect(await hasAudioStream(withTone)).toBe(true);
    expect(missing.checks).toContain("The requested soundtrack is missing from the export.");
    expect(audible.has_audio).toBe(true);
    expect(audible.audio_mean_db).not.toBeNull();
    expect(audible.checks).not.toContain("The requested soundtrack is silent or too quiet to verify.");
    expect((await probeRenderedVideo(withTone)).checks)
      .toContain("Captions-only export unexpectedly contains audio.");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}, 60_000);
