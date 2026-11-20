import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { produceSceneAudio, SceneAudioQualityError } from "./scene.js";

const words = [
  { text: "Explain", startSec: 0.1, endSec: 0.5, loss: 0.1 },
  { text: "the", startSec: 0.6, endSec: 0.8, loss: 0.1 },
  { text: "service.", startSec: 0.9, endSec: 1.4, loss: 0.1 },
];
const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(128)]);
const input = { sceneId: "s01", narration: "Explain the service.", maxAlignmentLoss: 0.25 };

describe("per-scene narration pipeline", () => {
  it("aligns the actual normalised MP3 and records its hash and measured duration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aa-scene-real-"));
    try {
      const path = join(dir, "sine.mp3");
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
        "-c:a", "libmp3lame", path], { timeout: 30_000 });
      const raw = await readFile(path);
      const align = vi.fn().mockResolvedValue({ loss: 0.1, words });
      const result = await produceSceneAudio(input, {
        synthesize: vi.fn().mockResolvedValue(raw), align,
      });
      expect(result.attempts).toBe(1);
      // MP3 encoder delay/padding can move the probed duration by a few frames.
      expect(Math.abs(result.durationSec - 4)).toBeLessThan(0.1);
      expect(Math.abs(result.measuredLufs + 16)).toBeLessThanOrEqual(1);
      expect(result.audioSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(align.mock.calls[0]?.[0]).toEqual(result.mp3);
      expect(result.mp3).not.toEqual(raw);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 60_000);
  it("retries poor alignment once and holds a second failed take", async () => {
    const normalise = vi.fn(async (_source: string, target: string) => {
      await writeFile(target, mp3);
      return { durationSec: 2, measuredLufs: -16 };
    });
    const align = vi.fn()
      .mockResolvedValueOnce({ loss: 0.5, words })
      .mockResolvedValueOnce({ loss: 0.1, words });
    const synthesize = vi.fn().mockResolvedValue(mp3);
    const result = await produceSceneAudio(input, { synthesize, align, normalise });
    expect(result.attempts).toBe(2);
    expect(synthesize).toHaveBeenCalledTimes(2);
    const bad = vi.fn().mockResolvedValue({ loss: 0.5, words });
    await expect(produceSceneAudio(input, { synthesize, align: bad, normalise }))
      .rejects.toBeInstanceOf(SceneAudioQualityError);
    expect(bad).toHaveBeenCalledTimes(2);
  });
  it("rejects an invalid loss policy before calling speech synthesis", async () => {
    const synthesize = vi.fn();
    await expect(produceSceneAudio({ ...input, maxAlignmentLoss: Number.NaN },
      { synthesize, align: vi.fn() })).rejects.toThrow(/alignment policy/);
    expect(synthesize).not.toHaveBeenCalled();
  });
});
