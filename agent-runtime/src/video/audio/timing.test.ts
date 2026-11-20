import { describe, expect, it } from "vitest";
import { sceneTimingFromAlignment, videoTimings } from "./timing.js";

const base = {
  sceneId: "s01", narration: "[calm] Explain the service.",
  audioSrc: "https://example.invalid/s01.mp3", audioDurationSec: 2,
  maxLoss: 0.25,
  alignment: { loss: 0.1, words: [
    { text: "Explain", startSec: 0.1, endSec: 0.5, loss: 0.1 },
    { text: "the", startSec: 0.55, endSec: 0.75, loss: 0.1 },
    { text: "service.", startSec: 0.8, endSec: 1.2, loss: 0.1 },
  ] },
};

describe("scene audio timing", () => {
  it("converts measured audio and exact aligned words into renderer timing", () => {
    const first = sceneTimingFromAlignment(base);
    expect(first).toMatchObject({ id: "s01", durationSec: 2 });
    expect(first.words[0]).toMatchObject({ text: "Explain", startSec: 0.1, endSec: 0.5 });
    const all = videoTimings([first, { ...first, id: "s02" }, { ...first, id: "s03" }], null);
    expect(all.musicSrc).toBeNull();
    expect(all.scenes.map((scene) => scene.id)).toEqual(["s01", "s02", "s03"]);
  });
  it("holds bad loss, transcript drift and timing outside actual audio", () => {
    expect(() => sceneTimingFromAlignment({ ...base, maxLoss: 0.05 }))
      .toThrow(/quality is invalid/);
    expect(() => sceneTimingFromAlignment({ ...base, narration: "Explain another service." }))
      .toThrow(/differ from narration/);
    expect(() => sceneTimingFromAlignment({ ...base, audioDurationSec: 1 }))
      .toThrow(/invalid word timing/);
  });
  it("accepts the physical audio tail within 25 seconds and refuses longer scenes", () => {
    expect(sceneTimingFromAlignment({ ...base, audioDurationSec: 25 }).durationSec).toBe(25);
    expect(() => sceneTimingFromAlignment({ ...base, audioDurationSec: 25.01 }))
      .toThrow(/duration or alignment quality/);
    const first = sceneTimingFromAlignment(base);
    expect(() => videoTimings([first, { ...first, id: "s03" },
      { ...first, id: "s04" }], null)).toThrow(/ordered scenes/);
  });
});
