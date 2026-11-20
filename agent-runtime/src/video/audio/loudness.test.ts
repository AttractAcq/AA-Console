import { execFileSync, spawnSync } from "node:child_process";
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
  it("trims a long leading pause and files one 400 ms silence tail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aa-video-speech-finish-"));
    try {
      const input = join(dir, "speech.mp3");
      const output = join(dir, "finished.mp3");
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=0.35",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
        "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[a]",
        "-map", "[a]", "-c:a", "libmp3lame", input], { timeout: 30_000 });
      const result = await normaliseTo(input, output, -16,
        { trimLeadingSilenceOverSec: 0.15, padTailSec: 0.4 });
      expect(result.durationSec).toBeGreaterThan(2.35);
      expect(result.durationSec).toBeLessThan(2.52);
      expect(Math.abs(result.measuredLufs + 16)).toBeLessThanOrEqual(1);
      const silence = spawnSync("ffmpeg", ["-hide_banner", "-nostdin",
        "-i", output, "-af", "silencedetect=noise=-50dB:d=0.25",
        "-f", "null", "-"], { timeout: 30_000, encoding: "utf8" });
      expect(silence.status).toBe(0);
      const tailStarts = [...silence.stderr.matchAll(/silence_start:\s*([\d.]+)/g)]
        .map((match) => Number(match[1]));
      expect(tailStarts).toHaveLength(1);
      expect(tailStarts[0]).toBeGreaterThan(1.9);
      expect(tailStarts[0]).toBeLessThan(2.1);
      const shortInput = join(dir, "short-pause.mp3");
      const shortOutput = join(dir, "short-pause-finished.mp3");
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=0.1",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
        "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[a]",
        "-map", "[a]", "-c:a", "libmp3lame", shortInput], { timeout: 30_000 });
      const short = await normaliseTo(shortInput, shortOutput, -16,
        { trimLeadingSilenceOverSec: 0.15, padTailSec: 0.4 });
      expect(short.durationSec).toBeGreaterThan(2.45);
      expect(short.durationSec).toBeLessThan(2.62);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 60_000);
});
