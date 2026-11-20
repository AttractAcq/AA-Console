import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ElevenLabsHttpError } from "./elevenlabs.js";
import { composeMusic, musicLengthMs, musicPrompt, prepareMusicBed } from "./music.js";

const fakeMp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(128)]);

describe("instrumental video music", () => {
  it("uses the official endpoint with forced instrumental and bounded length", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(Uint8Array.from(fakeMp3), {
      status: 200, headers: { "content-type": "audio/mpeg", "song-id": "song-123" },
    }));
    const result = await composeMusic({ apiKey: "managed-test-key",
      prompt: musicPrompt("warm piano", "calm"), requestedLengthMs: 30_000,
      fetchImpl });
    expect(result).toMatchObject({ songId: "song-123",
      modelId: "music_v2_5", requestedLengthMs: 30_000 });
    expect(result.mp3).toEqual(fakeMp3);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.elevenlabs.io/v1/music?output_format=mp3_48000_192",
      expect.objectContaining({ method: "POST",
        body: JSON.stringify({ prompt: musicPrompt("warm piano", "calm"),
          music_length_ms: 30_000, model_id: "music_v2_5",
          force_instrumental: true }) }));
    expect(musicLengthMs(120)).toBe(122_000);
    expect(musicLengthMs(900)).toBe(300_000);
  });
  it("rejects missing credentials, invalid media and provider failures", async () => {
    const fetchImpl = vi.fn();
    await expect(composeMusic({ apiKey: "", prompt: "instrumental",
      requestedLengthMs: 30_000, fetchImpl })).rejects.toThrow(/credentials/);
    expect(fetchImpl).not.toHaveBeenCalled();
    fetchImpl.mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    await expect(composeMusic({ apiKey: "key", prompt: "instrumental",
      requestedLengthMs: 30_000, fetchImpl }))
      .rejects.toMatchObject({ status: 429, retryable: true });
    fetchImpl.mockResolvedValueOnce(new Response("not audio", {
      status: 200, headers: { "content-type": "text/plain" },
    }));
    await expect(composeMusic({ apiKey: "key", prompt: "instrumental",
      requestedLengthMs: 30_000, fetchImpl }))
      .rejects.toThrow(/did not return audio/);
    expect(new ElevenLabsHttpError(422, "Music").retryable).toBe(false);
  });
  it("normalises a local instrumental fixture to -24 LUFS and retains provenance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aa-music-real-"));
    try {
      const source = join(dir, "sine.mp3");
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "sine=frequency=220:duration=4",
        "-c:a", "libmp3lame", source], { timeout: 30_000 });
      const raw = await readFile(source);
      const compose = vi.fn().mockResolvedValue({ mp3: raw,
        songId: "song-fixture", modelId: "music_v2_5", requestedLengthMs: 5000 });
      const bed = await prepareMusicBed({ apiKey: "managed-test-key",
        mood: "warm piano", tone: "calm", videoDurationSec: 5, compose });
      expect(bed.songId).toBe("song-fixture");
      expect(bed.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Math.abs(bed.measuredLufs + 24)).toBeLessThanOrEqual(1);
      expect(bed.durationSec).toBeGreaterThan(3.8);
      expect(bed.loopRequired).toBe(true);
      expect(compose).toHaveBeenCalledWith(expect.objectContaining({
        requestedLengthMs: 7000, prompt: expect.stringContaining("no vocals") }));
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 60_000);
});
