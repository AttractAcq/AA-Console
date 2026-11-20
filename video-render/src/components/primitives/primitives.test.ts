import { describe, expect, it } from "vitest";
import { AudioBedSchema, musicGainAtFrame } from "./AudioTracks.js";
import { captionPlacement, layoutCaptionPages } from "./CaptionLayer.js";

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

  it("keeps a prepared -24 LUFS bed at unity outside speech and ducks 14 dB inside", () => {
    const defaults = AudioBedSchema.parse({ musicSrc: "music.mp3",
      speechIntervals: [[1, 3]] });
    expect(defaults.bedDb).toBe(0);
    expect(musicGainAtFrame(0, 30, defaults.speechIntervals,
      defaults.bedDb, defaults.duckDb)).toBeCloseTo(1);
    expect(musicGainAtFrame(60, 30, defaults.speechIntervals,
      defaults.bedDb, defaults.duckDb)).toBeCloseTo(10 ** (-14 / 20));
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

  it("wraps timed caption tokens into no more than two 32-character lines", () => {
    const captions = Array.from({ length: 16 }, (_, index) => ({
      text: `evidence${index} `, startMs: index * 240, endMs: index * 240 + 210,
      timestampMs: index * 240, confidence: null,
    }));
    const pages = layoutCaptionPages(captions);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.lines.length).toBeLessThanOrEqual(2);
      for (const line of page.lines) expect(Array.from(line.map((token) => token.text).join(" ")).length).toBeLessThanOrEqual(32);
    }
    expect(pages[0]?.lines[0]?.[0]?.fromMs).toBe(0);
    expect(() => layoutCaptionPages([{ text: `${"x".repeat(33)} `, startMs: 0, endMs: 200, timestampMs: 0, confidence: null }])).toThrow("32 characters");
  });
});
