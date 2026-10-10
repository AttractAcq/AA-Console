import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { Edl, EdlCaption } from "../video_edit/edl.js";

const run = promisify(execFile);
export type Word = { word: string; start: number; end: number };
export type Transcript = { text: string; words: Word[]; language: string | null };

export function parseTranscript(raw: unknown, durationSec: number): Transcript {
  if (!raw || typeof raw !== "object") throw new Error("The transcription response was empty.");
  const value = raw as Record<string, unknown>;
  if (typeof value.text !== "string" || !Array.isArray(value.words)) {
    throw new Error("The transcription response has no timed words.");
  }
  const words: Word[] = [];
  for (const item of value.words) {
    if (!item || typeof item !== "object") throw new Error("A transcript word has no timing.");
    const row = item as Record<string, unknown>;
    if (typeof row.word !== "string" || !row.word.trim()
      || typeof row.start !== "number" || typeof row.end !== "number"
      || !Number.isFinite(row.start) || !Number.isFinite(row.end)
      || row.start < 0 || row.end <= row.start || row.end > durationSec + 1) {
      throw new Error("A transcript word has invalid timing.");
    }
    words.push({ word: row.word.trim(), start: row.start, end: row.end });
  }
  if (words.length > 10_000) throw new Error("The transcript is too long for this edit.");
  words.sort((a, b) => a.start - b.start);
  return { text: value.text.trim(), words,
    language: typeof value.language === "string" ? value.language : null };
}

export async function hasAudioStream(path: string): Promise<boolean> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=index", "-of", "csv=p=0", path], { timeout: 30_000 });
  return Boolean(stdout.trim());
}

/** Whisper supplies word timestamps; Claude makes the cuts and captions follow them. */
export async function transcribeSource(path: string, workDir: string, apiKey: string,
  durationSec: number): Promise<Transcript> {
  const audioPath = `${workDir}/speech.mp3`;
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", path,
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "64k", audioPath],
  { timeout: 120_000 });
  const audio = await readFile(audioPath);
  if (audio.length > 24 * 1024 * 1024) throw new Error("The extracted audio is too large to transcribe.");
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(audio)], { type: "audio/mpeg" }), "speech.mp3");
  form.set("model", "whisper-1");
  form.set("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form,
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`Transcription returned HTTP ${response.status}.`);
  return parseTranscript(await response.json(), durationSec);
}

/** Captions are source words at mapped cut times, never model-invented text. */
export function captionsForCut(edl: Edl, words: readonly Word[]): EdlCaption[] {
  const captions: EdlCaption[] = [];
  let cursor = 0;
  for (const segment of edl.segments) {
    const picked = words.filter((word) => {
      const midpoint = (word.start + word.end) / 2;
      return midpoint >= segment.in_sec && midpoint <= segment.out_sec;
    });
    let group: Word[] = [];
    const flush = () => {
      if (group.length === 0) return;
      const text = group.map((word) => word.word).join(" ");
      const start = cursor + Math.max(0, group[0]!.start - segment.in_sec);
      const end = Math.min(cursor + segment.out_sec - segment.in_sec,
        Math.max(start + 0.8, cursor + group[group.length - 1]!.end - segment.in_sec + 0.15));
      if (end - start >= 0.8 && text.length <= 60) captions.push({ text, start_sec: start,
        end_sec: end, position: "bottom" });
      group = [];
    };
    for (const word of picked) {
      const next = [...group, word];
      if (group.length > 0 && (next.length > 6
        || next.map((part) => part.word).join(" ").length > 48
        || word.end - group[0]!.start > 2.5)) flush();
      group.push(word);
    }
    flush();
    cursor += segment.out_sec - segment.in_sec;
  }
  return captions;
}
