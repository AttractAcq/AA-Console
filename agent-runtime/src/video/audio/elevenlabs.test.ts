import { describe, expect, it, vi } from "vitest";
import { ElevenLabsHttpError, forcedAlignment, spokenTranscript,
  textToSpeech } from "./elevenlabs.js";

const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(128)]);
const key = "private-test-key";

describe("ElevenLabs audio transport", () => {
  it("requests v3 MP3 narration with the exact voice and preserves audio tags", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(mp3), {
      status: 200, headers: { "content-type": "audio/mpeg" },
    }));
    const audio = await textToSpeech({ apiKey: key, voiceId: "voice12345678",
      narration: "[calm] Explain the service.", fetchImpl: send });
    expect(audio).toEqual(mp3);
    expect(send).toHaveBeenCalledWith(expect.stringContaining(
      "/v1/text-to-speech/voice12345678?output_format=mp3_44100_128"),
    expect.objectContaining({ method: "POST", body: JSON.stringify({
      text: "[calm] Explain the service.", model_id: "eleven_v3",
    }) }));
    expect(spokenTranscript("[calm] Explain [pause] the service.")).toBe("Explain the service.");
  });
  it("sends MP3 and plain narration to forced alignment, validating ordered words", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      loss: 0.1, words: [
        { text: "Explain", start: 0.1, end: 0.5, loss: 0.1 },
        { text: "service", start: 0.6, end: 1.0, loss: 0.2 },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const alignment = await forcedAlignment({ apiKey: key, mp3,
      narration: "[calm] Explain service", fetchImpl: send });
    expect(alignment.loss).toBe(0.1);
    expect(alignment.words).toHaveLength(2);
    expect(alignment.words[0]).toMatchObject({ text: "Explain", startSec: 0.1 });
    const [, options] = send.mock.calls[0]!;
    const body = options?.body as FormData;
    expect(body.get("text")).toBe("Explain service");
    expect(body.get("file")).toBeInstanceOf(File);
  });
  it("classifies transient provider failures without exposing the key or body", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      `credential echoed: ${key}`, { status: 429 }));
    let caught: unknown;
    try { await textToSpeech({ apiKey: key, voiceId: "voice12345678",
      narration: "Explain the service.", fetchImpl: send }); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ElevenLabsHttpError);
    expect((caught as ElevenLabsHttpError).retryable).toBe(true);
    expect(String(caught)).not.toContain(key);
    const bad = vi.fn<typeof fetch>().mockResolvedValue(new Response("bad request", { status: 400 }));
    await expect(textToSpeech({ apiKey: key, voiceId: "voice12345678",
      narration: "Explain the service.", fetchImpl: bad }))
      .rejects.toMatchObject({ retryable: false });
  });
  it("rejects unsupported tags, non-audio success and invalid word order", async () => {
    expect(() => spokenTranscript("[unsupported] Explain.")).toThrow(/unsupported audio tags/);
    await expect(textToSpeech({ apiKey: key, voiceId: "",
      narration: "Explain the service.", fetchImpl: vi.fn() }))
      .rejects.toThrow(/credentials/);
    const json = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", {
      status: 200, headers: { "content-type": "application/json" },
    }));
    await expect(textToSpeech({ apiKey: key, voiceId: "voice12345678",
      narration: "Explain the service.", fetchImpl: json })).rejects.toThrow(/did not return audio/);
    const backward = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      loss: 0.2, words: [
        { text: "first", start: 0.5, end: 0.7 },
        { text: "second", start: 0.2, end: 0.4 },
      ],
    }), { status: 200 }));
    await expect(forcedAlignment({ apiKey: key, mp3,
      narration: "first second", fetchImpl: backward }))
      .rejects.toThrow(/unordered word timings/);
  });
});
