import { expect, it } from "vitest";
import { validateCandidates } from "./index.js";

const words = [
  { word: "We", start: 4, end: 4.3 },
  { word: "made", start: 4.4, end: 4.8 },
  { word: "it", start: 4.9, end: 5.1 },
  { word: "simple.", start: 5.2, end: 5.8 },
];

it("grounds a quote candidate in timed source words", () => {
  const result = validateCandidates({ candidates: [{ kind: "quote_image", title: "Simple process",
    reason: "Strong concise line", start_sec: 3.9, end_sec: 6.2 }] }, words, 10);
  expect(result[0]).toMatchObject({ exact_quote: "We made it simple.", start_sec: 3.9,
    end_sec: 6.2 });
});

it("rejects invented or ungrounded candidate ranges", () => {
  expect(() => validateCandidates({ candidates: [{ kind: "short_clip", title: "False clip",
    reason: "", start_sec: 0, end_sec: 9 }] }, words, 8)).toThrow(/invalid source range/);
  expect(() => validateCandidates({ candidates: [{ kind: "quote_image", title: "No speech",
    reason: "", start_sec: 7, end_sec: 9 }] }, words, 10)).toThrow(/no transcribed speech/);
});
