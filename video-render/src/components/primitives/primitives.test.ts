import { describe, expect, it } from "vitest";
import { AudioBedSchema, musicGainAtFrame } from "./AudioTracks.js";
import { captionPlacement } from "./CaptionLayer.js";

describe("audio mixing", () => {
  it("ducks during speech and ramps over twelve frames", () => {
    const intervals: [number, number][] = [[1, 3]];
    const bed = musicGainAtFrame(0, 30, intervals, -24, -14);
    const ramp = musicGainAtFrame(24, 30, intervals, -24, -14);
    const speech = musicGainAtFrame(30, 30, intervals, -24, -14);
    expect(bed).toBeGreaterThan(ramp);
    expect(ramp).toBeGreaterThan(speech);
    expect(musicGainAtFrame(110, 30, intervals, -24, -14)).toBeCloseTo(bed);
  });

  it("rejects reversed speech intervals", () => {
    expect(() => AudioBedSchema.parse({ musicSrc: "music.mp3", speechIntervals: [[3, 1]] })).toThrow();
  });
});

describe("caption placement", () => {
  it("keeps captions away from declared component text", () => {
    expect(captionPlacement({ x: 0.1, y: 0.35, width: 0.8, height: 0.3 })).toBe("bottom");
    expect(captionPlacement({ x: 0.1, y: 0.72, width: 0.8, height: 0.25 })).toBe("top");
    expect(captionPlacement({ x: 0.1, y: 0.05, width: 0.8, height: 0.9 })).toBe("hidden");
  });
});
