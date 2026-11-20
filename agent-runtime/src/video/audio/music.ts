import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ElevenLabsHttpError } from "./elevenlabs.js";
import { normaliseTo } from "./loudness.js";

const API = "https://api.elevenlabs.io/v1/music";
const MAX_MUSIC_MS = 300_000; // Provider overview currently says five minutes.
const MAX_AUDIO_BYTES = 40 * 1024 * 1024;

export type ComposedMusic = { mp3: Buffer; songId: string | null;
  modelId: "music_v2_5"; requestedLengthMs: number };
export type MusicBed = ComposedMusic & { mp3: Buffer; durationSec: number;
  measuredLufs: number; sha256: string; loopRequired: boolean; prompt: string };

export function musicPrompt(mood: string, tone: string): string {
  if (!mood.trim() || mood.length > 80
    || !["calm", "confident", "energetic"].includes(tone)) {
    throw new Error("Video music mood or tone is invalid.");
  }
  return `instrumental, no vocals, ${mood.trim()}, ${tone}, loopable, suitable for an educational explainer`;
}

export function musicLengthMs(videoDurationSec: number): number {
  if (!Number.isFinite(videoDurationSec)
    || videoDurationSec < 3 || videoDurationSec > 900) {
    throw new Error("Video duration for music must be between 3 and 900 seconds.");
  }
  return Math.min(MAX_MUSIC_MS, Math.ceil((videoDurationSec + 2) * 1000));
}

/** Official Compose Music endpoint; call only after a project-level release gate. */
export async function composeMusic(input: { apiKey: string; prompt: string;
  requestedLengthMs: number; fetchImpl?: typeof fetch }): Promise<ComposedMusic> {
  if (!input.apiKey.trim() || !input.prompt.trim() || input.prompt.length > 4100
    || !Number.isInteger(input.requestedLengthMs)
    || input.requestedLengthMs < 3000 || input.requestedLengthMs > MAX_MUSIC_MS) {
    throw new Error("Eleven Music request is invalid or missing credentials.");
  }
  const response = await (input.fetchImpl ?? fetch)(
    `${API}?output_format=mp3_48000_192`, {
      method: "POST", headers: { "xi-api-key": input.apiKey,
        "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ prompt: input.prompt,
        music_length_ms: input.requestedLengthMs,
        model_id: "music_v2_5", force_instrumental: true }),
      signal: AbortSignal.timeout(360_000),
    },
  );
  if (!response.ok) throw new ElevenLabsHttpError(response.status, "Music composition");
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("audio/") && !contentType.includes("application/octet-stream")) {
    throw new Error("Eleven Music did not return audio.");
  }
  const mp3 = Buffer.from(await response.arrayBuffer());
  if (mp3.length < 100 || mp3.length > MAX_AUDIO_BYTES
    || !(mp3.subarray(0, 3).toString("ascii") === "ID3"
      || (mp3[0] === 0xff && ((mp3[1] ?? 0) & 0xe0) === 0xe0))) {
    throw new Error("Eleven Music returned invalid MP3 bytes.");
  }
  const songId = response.headers.get("song-id")?.trim() || null;
  return { mp3, songId, modelId: "music_v2_5",
    requestedLengthMs: input.requestedLengthMs };
}

/** Normalize a generated instrumental bed; caller owns Storage and fallback. */
export async function prepareMusicBed(input: { apiKey: string; mood: string;
  tone: string; videoDurationSec: number;
  compose?: typeof composeMusic; normalise?: typeof normaliseTo;
  onComposition?: (result: ComposedMusic) => Promise<void> }): Promise<MusicBed> {
  const prompt = musicPrompt(input.mood, input.tone);
  const requestedLengthMs = musicLengthMs(input.videoDurationSec);
  const work = await mkdtemp(join(tmpdir(), "aa-video-music-"));
  try {
    const composed = await (input.compose ?? composeMusic)({
      apiKey: input.apiKey, prompt, requestedLengthMs,
    });
    await input.onComposition?.(composed);
    const rawPath = join(work, "raw.mp3");
    const bedPath = join(work, "bed.mp3");
    await writeFile(rawPath, composed.mp3, { flag: "wx" });
    const normalized = await (input.normalise ?? normaliseTo)(rawPath,
      bedPath, -24);
    const mp3 = await readFile(bedPath);
    if (mp3.length < 100 || mp3.length > MAX_AUDIO_BYTES
      || Math.abs(normalized.measuredLufs + 24) > 1) {
      throw new Error("Normalized music bed is invalid or outside its loudness target.");
    }
    return { ...composed, mp3,
      durationSec: normalized.durationSec,
      measuredLufs: normalized.measuredLufs,
      sha256: createHash("sha256").update(mp3).digest("hex"),
      loopRequired: normalized.durationSec < input.videoDurationSec,
      prompt };
  } finally { await rm(work, { recursive: true, force: true }); }
}
