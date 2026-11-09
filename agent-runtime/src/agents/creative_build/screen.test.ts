import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  BLANK_LIGHT_AT, DARK_REVIEW_AT, compositionNote, frameVerdict,
  isNearlyBlank, measureComposition, type FrameComposition,
} from "./screen.js";

const frame = (light: number, dark: number, mean = 100): FrameComposition => ({
  flatLightFraction: light, flatDarkFraction: dark, meanLuminance: mean,
  width: 1024, height: 1536,
});

describe("production-calibrated composition screen", () => {
  it("raises dark card candidates missed by the light-only screen", () => {
    // A reviewed V2 typography frame has 57% flat dark area and no light stock.
    const darkCard = frame(0, .57, 75);
    expect(frameVerdict(darkCard)).toBe("dark_review");
    expect(compositionNote(darkCard)).toMatch(/review for a dark text card/i);
  });

  it("does not call a dark product photograph a card", () => {
    // Real object photos in the same cohort reached 66–83% flat dark area.
    for (const dark of [.66, .83]) {
      expect(frameVerdict(frame(0, dark, 50))).toBe("dark_review");
      expect(compositionNote(frame(0, dark, 50))).toMatch(/dark photography can/i);
    }
    expect(DARK_REVIEW_AT).toBeLessThan(.32);
  });

  it("retains the bright card signal without claiming that flatness proves type", () => {
    expect(frameVerdict(frame(.218, 0))).toBe("card_led");
    expect(compositionNote(frame(.218, 0))).toMatch(/possible text card/i);
    expect(frameVerdict(frame(.07, 0))).toBe("borderline");
    expect(frameVerdict(frame(.003, .01))).toBe("image_led");
  });

  it("blocks only the almost-empty light tail", () => {
    // Opened production frames: 01 is almost empty; 06 shows eight objects.
    expect(isNearlyBlank(frame(.9745, .008, 241.1))).toBe(true);
    expect(isNearlyBlank(frame(.8461, .006, 231.0))).toBe(false);
    expect(isNearlyBlank(frame(.98, 0, 210))).toBe(false);
    expect(BLANK_LIGHT_AT).toBeGreaterThan(.8461);
  });

  it("measures the actual pixels, including dark flatness and brightness", async () => {
    const white = await sharp({ create: {
      width: 1024, height: 1536, channels: 3, background: { r: 245, g: 245, b: 245 },
    } }).png().toBuffer();
    const black = await sharp({ create: {
      width: 1024, height: 1536, channels: 3, background: { r: 20, g: 20, b: 20 },
    } }).png().toBuffer();
    const light = await measureComposition(white);
    const dark = await measureComposition(black);
    expect(light).toMatchObject({ width: 1024, height: 1536 });
    expect(light.flatLightFraction).toBe(1);
    expect(isNearlyBlank(light)).toBe(true);
    expect(dark.flatDarkFraction).toBe(1);
    expect(isNearlyBlank(dark)).toBe(false);
  });
});
