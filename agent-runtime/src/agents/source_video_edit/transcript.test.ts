import { describe, expect, it } from "vitest";
import type { Edl } from "../video_edit/edl.js";
import { captionsForCut, parseTranscript } from "./transcript.js";

const edl: Edl = { segments: [
  { shot: 1, in_sec: 2, out_sec: 4, transition: "cut" },
  { shot: 1, in_sec: 6, out_sec: 8, transition: "cut" },
], captions: [], end_card_text: "", end_card_sec: 0, notes: "" };

describe("source transcription", () => {
  it("rejects words outside the real media duration", () => {
    expect(() => parseTranscript({ text: "hi", words: [{ word: "hi", start: 9, end: 12 }] }, 10))
      .toThrow(/invalid timing/);
  });

  it("maps only spoken source words onto the cut timeline", () => {
    const words = [
      { word: "Discarded", start: 0, end: 0.4 },
      { word: "Start", start: 2.2, end: 2.5 },
      { word: "here", start: 2.6, end: 2.9 },
      { word: "Then", start: 6.1, end: 6.4 },
      { word: "finish", start: 6.5, end: 6.9 },
    ];
    const captions = captionsForCut(edl, words);
    expect(captions.map((caption) => caption.text)).toEqual(["Start here", "Then finish"]);
    expect(captions[0]?.start_sec).toBeCloseTo(0.2);
    expect(captions[1]?.start_sec).toBeCloseTo(2.1);
  });
});
