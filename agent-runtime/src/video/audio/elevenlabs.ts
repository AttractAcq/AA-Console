// Transport boundary for the planned V4 audio stage. Callers own retries,
// cost receipts, Storage writes and project transitions.
const API = "https://api.elevenlabs.io";
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export type AlignedWord = { text: string; startSec: number;
  endSec: number; loss: number | null };
export type Alignment = { words: AlignedWord[]; loss: number };

export class ElevenLabsHttpError extends Error {
  readonly retryable: boolean;
  constructor(readonly status: number, operation: string) {
    super(`${operation} returned HTTP ${status}.`);
    this.retryable = status === 429 || status >= 500;
  }
}

function credentials(apiKey: string, voiceId?: string): void {
  if (!apiKey.trim() || (voiceId !== undefined && !/^[A-Za-z0-9_-]{8,80}$/.test(voiceId))) {
    throw new Error("ElevenLabs credentials are unavailable or invalid.");
  }
}

export function spokenTranscript(narration: string): string {
  const plain = narration.replace(/\[(?:pause|emphasis|slow|excited|calm)\]/gi, " ")
    .replace(/\s+/g, " ").trim();
  if (!plain || plain.length > 5000 || /\[[^\]]+\]/.test(plain)) {
    throw new Error("Narration contains unsupported audio tags or no spoken text.");
  }
  return plain;
}

export async function textToSpeech(input: {
  apiKey: string; voiceId: string; narration: string;
  fetchImpl?: typeof fetch;
}): Promise<Buffer> {
  credentials(input.apiKey, input.voiceId);
  if (!input.narration.trim() || input.narration.length > 5000) {
    throw new Error("Narration must contain 1–5000 characters.");
  }
  spokenTranscript(input.narration);
  const response = await (input.fetchImpl ?? fetch)(
    `${API}/v1/text-to-speech/${encodeURIComponent(input.voiceId)}?output_format=mp3_44100_128`,
    { method: "POST", headers: { "xi-api-key": input.apiKey,
      "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text: input.narration, model_id: "eleven_v3" }),
      signal: AbortSignal.timeout(180_000) },
  );
  if (!response.ok) throw new ElevenLabsHttpError(response.status, "Speech generation");
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("audio/") && !contentType.includes("application/octet-stream")) {
    throw new Error("Speech generation did not return audio.");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 100 || bytes.length > MAX_AUDIO_BYTES
    || !(bytes.subarray(0, 3).toString("ascii") === "ID3"
      || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0))) {
    throw new Error("Speech generation returned invalid MP3 bytes.");
  }
  return bytes;
}

export async function forcedAlignment(input: {
  apiKey: string; mp3: Buffer; narration: string;
  fetchImpl?: typeof fetch;
}): Promise<Alignment> {
  credentials(input.apiKey);
  if (input.mp3.length < 100 || input.mp3.length > MAX_AUDIO_BYTES) {
    throw new Error("Audio for forced alignment is outside the supported size.");
  }
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(input.mp3)], { type: "audio/mpeg" }), "scene.mp3");
  form.set("text", spokenTranscript(input.narration));
  const response = await (input.fetchImpl ?? fetch)(`${API}/v1/forced-alignment`, {
    method: "POST", headers: { "xi-api-key": input.apiKey }, body: form,
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new ElevenLabsHttpError(response.status, "Forced alignment");
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Forced alignment response is invalid.");
  }
  const result = data as Record<string, unknown>;
  if (!Number.isFinite(result.loss) || (result.loss as number) < 0
    || !Array.isArray(result.words) || !result.words.length) {
    throw new Error("Forced alignment response has no usable words or loss score.");
  }
  const words: AlignedWord[] = [];
  for (const raw of result.words) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Forced alignment contains an invalid word.");
    }
    const word = raw as Record<string, unknown>;
    if (typeof word.text !== "string" || !word.text.trim()
      || !Number.isFinite(word.start) || !Number.isFinite(word.end)
      || (word.start as number) < 0 || (word.end as number) <= (word.start as number)
      || (words.length > 0 && (word.start as number) < words[words.length - 1]!.startSec)
      || (word.loss != null && (!Number.isFinite(word.loss) || (word.loss as number) < 0))) {
      throw new Error("Forced alignment has invalid or unordered word timings.");
    }
    words.push({ text: word.text, startSec: word.start as number,
      endSec: word.end as number, loss: word.loss == null ? null : word.loss as number });
  }
  return { words, loss: result.loss as number };
}
