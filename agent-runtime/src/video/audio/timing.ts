import { spokenTranscript, type Alignment } from "./elevenlabs.js";

export type SceneTiming = { id: string; audioSrc: string; durationSec: number;
  words: Array<{ text: string; startSec: number; endSec: number }> };

function tokens(text: string): string[] {
  return text.toLocaleLowerCase("en").match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** The caller supplies measured MP3 duration and an explicit loss policy. */
export function sceneTimingFromAlignment(input: {
  sceneId: string; narration: string; audioSrc: string;
  audioDurationSec: number; alignment: Alignment; maxLoss: number;
}): SceneTiming {
  if (!/^s\d{2}$/.test(input.sceneId) || !input.audioSrc.trim()
    || !Number.isFinite(input.audioDurationSec)
    || input.audioDurationSec <= 0 || input.audioDurationSec > 24.6
    || !Number.isFinite(input.maxLoss) || input.maxLoss < 0
    || input.alignment.loss > input.maxLoss) {
    throw new Error(`${input.sceneId}: audio duration or alignment quality is invalid.`);
  }
  const spoken = tokens(spokenTranscript(input.narration));
  const aligned = input.alignment.words.flatMap((word) => tokens(word.text));
  if (!spoken.length || spoken.join("|") !== aligned.join("|")) {
    throw new Error(`${input.sceneId}: aligned words differ from narration.`);
  }
  let previousEnd = 0;
  const words = input.alignment.words.map((word) => {
    if (!word.text.trim() || !Number.isFinite(word.startSec)
      || !Number.isFinite(word.endSec) || word.startSec < previousEnd - 0.02
      || word.startSec < 0 || word.endSec <= word.startSec
      || word.endSec > input.audioDurationSec + 0.02
      || (word.loss != null && word.loss > input.maxLoss)) {
      throw new Error(`${input.sceneId}: alignment has invalid word timing or loss.`);
    }
    previousEnd = word.endSec;
    return { text: word.text, startSec: word.startSec, endSec: word.endSec };
  });
  return { id: input.sceneId, audioSrc: input.audioSrc,
    durationSec: input.audioDurationSec, words };
}

export function videoTimings(scenes: SceneTiming[], musicSrc: string | null): {
  musicSrc: string | null; scenes: SceneTiming[];
} {
  if (scenes.length < 3 || scenes.length > 40
    || scenes.some((scene, index) => scene.id !== `s${String(index + 1).padStart(2, "0")}`)
    || (musicSrc !== null && !musicSrc.trim())) {
    throw new Error("Video timings do not cover ordered scenes or music source.");
  }
  return { musicSrc, scenes };
}
