import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { measureLufs, normaliseTo, probeAudioDurationSec } from "./loudness.js";

describe("video narration loudness", () => {
  it("normalises a real MP3 near -16 LUFS and measures its duration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aa-video-loudness-"));
    try {
      const input = join(dir, "input.mp3");
      const output = join(dir, "normalised.mp3");
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
        "-c:a", "libmp3lame", input], { timeout: 30_000 });
      const before = await measureLufs(input);
      expect(Number.isFinite(before.integratedLufs)).toBe(true);
      const result = await normaliseTo(input, output, -16);
      expect(Math.abs(result.measuredLufs + 16)).toBeLessThanOrEqual(1);
      expect(result.durationSec).toBeGreaterThan(3.9);
      expect(await probeAudioDurationSec(output)).toBeCloseTo(result.durationSec, 2);
      await expect(normaliseTo(input, output, -16)).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 60_000);
  it("refuses an unsafe target and an overwrite of the source", async () => {
    await expect(normaliseTo("in.mp3", "out.mp3", -5)).rejects.toThrow(/-30 and -10/);
    await expect(normaliseTo("in.mp3", "in.mp3", -16)).rejects.toThrow(/distinct MP3/);
  });
});
