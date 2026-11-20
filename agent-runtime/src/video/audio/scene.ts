import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forcedAlignment, textToSpeech, type Alignment } from "./elevenlabs.js";
import { normaliseTo } from "./loudness.js";
import { sceneTimingFromAlignment } from "./timing.js";

export type SceneAudio = { mp3: Buffer; alignment: Alignment;
  durationSec: number; measuredLufs: number; attempts: number;
  narrationSha256: string; audioSha256: string };

export class SceneAudioQualityError extends Error {
  constructor(readonly sceneId: string, readonly attempts: number) {
    super(`${sceneId}: audio alignment did not meet the supplied quality policy after ${attempts} attempt(s).`);
  }
}

type Dependencies = {
  synthesize: (narration: string) => Promise<Buffer>;
  align: (mp3: Buffer, narration: string) => Promise<Alignment>;
  normalise?: typeof normaliseTo;
};

/** The result is not filed in Storage; the caller must bind it to an exact project scene. */
export async function produceSceneAudio(input: {
  sceneId: string; narration: string; maxAlignmentLoss: number;
}, dependencies: Dependencies): Promise<SceneAudio> {
  if (!/^s\d{2}$/.test(input.sceneId) || !input.narration.trim()
    || !Number.isFinite(input.maxAlignmentLoss) || input.maxAlignmentLoss < 0) {
    throw new Error("Video scene identity, narration or alignment policy is invalid.");
  }
  const work = await mkdtemp(join(tmpdir(), "aa-video-audio-"));
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const inputPath = join(work, `speech-${attempt}.mp3`);
      const outputPath = join(work, `levelled-${attempt}.mp3`);
      const raw = await dependencies.synthesize(input.narration);
      await writeFile(inputPath, raw, { flag: "wx" });
      const normalized = await (dependencies.normalise ?? normaliseTo)(inputPath,
        outputPath, -16);
      const mp3 = await readFile(outputPath);
      if (mp3.length < 100 || mp3.length > 20 * 1024 * 1024) {
        throw new Error(`${input.sceneId}: normalised audio size is invalid.`);
      }
      const alignment = await dependencies.align(mp3, input.narration);
      try {
        sceneTimingFromAlignment({ sceneId: input.sceneId,
          narration: input.narration, audioSrc: "local:normalised-mp3",
          audioDurationSec: normalized.durationSec, alignment,
          maxLoss: input.maxAlignmentLoss });
      } catch {
        if (attempt === 2) throw new SceneAudioQualityError(input.sceneId, attempt);
        continue;
      }
      return { mp3, alignment, durationSec: normalized.durationSec,
        measuredLufs: normalized.measuredLufs, attempts: attempt,
        narrationSha256: createHash("sha256").update(input.narration).digest("hex"),
        audioSha256: createHash("sha256").update(mp3).digest("hex") };
    }
    throw new SceneAudioQualityError(input.sceneId, 2);
  } finally { await rm(work, { recursive: true, force: true }); }
}

export function elevenLabsSceneDependencies(apiKey: string, voiceId: string): Dependencies {
  return { synthesize: (narration) => textToSpeech({ apiKey, voiceId, narration }),
    align: (mp3, narration) => forcedAlignment({ apiKey, mp3, narration }) };
}
