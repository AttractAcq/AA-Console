import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CARD_LED_AT,
  IMAGE_LED_UNDER,
  compositionNote,
  frameVerdict,
  measureComposition,
  type FrameComposition,
} from "./screen.js";

/**
 * The judgement, and the measurement against images that really are what they
 * claim to be.
 *
 * The figures in the first block are from production. They are the reason the
 * thresholds are where they are, so they are written down here: if a change
 * moves the measurement, these fail rather than the thresholds silently
 * ceasing to mean anything.
 */
const m = (flatLightFraction: number): FrameComposition =>
  ({ flatLightFraction, width: 1024, height: 1536 });

describe("where the thresholds came from", () => {
  it("clears the image-led renders measured in production", () => {
    // Another client's output, same validator, same period: 0.0%, 0.0%, 0.3%.
    for (const v of [0, 0, 0.003]) expect(frameVerdict(m(v))).toBe("image_led");
  });

  it("catches the card-led renders measured in production", () => {
    // The client with the defect, across all four treatments.
    for (const v of [0.218, 0.241, 0.270, 0.288, 0.326, 0.350, 0.373, 0.409, 0.463]) {
      expect(frameVerdict(m(v))).toBe("card_led");
    }
  });

  it("leaves a gap between them rather than splitting the difference", () => {
    // Three times the highest image-led render and half the lowest card-led
    // one. Two orders of magnitude separate the groups; the thresholds should
    // not be near either.
    expect(IMAGE_LED_UNDER).toBeGreaterThan(0.003 * 3);
    expect(CARD_LED_AT).toBeLessThan(0.218 / 2);
    expect(IMAGE_LED_UNDER).toBeLessThan(CARD_LED_AT);
  });

  it("says so rather than guessing in between", () => {
    expect(frameVerdict(m(0.07))).toBe("borderline");
  });
});

describe("what the job's event log says", () => {
  it("names the number and what it means", () => {
    expect(compositionNote(m(0.373))).toMatch(/37\.3% flat card stock/);
    expect(compositionNote(m(0.373))).toMatch(/text card with imagery around it/);
    expect(compositionNote(m(0))).toMatch(/image-led/);
  });

  it("does not call a card wrong", () => {
    // A worksheet lead magnet genuinely is a document. The note raises it; the
    // brand owner decides. Nothing here refuses a render.
    expect(compositionNote(m(0.46))).toMatch(/worth a look/);
    expect(compositionNote(m(0.46))).not.toMatch(/refus|reject|invalid/i);
  });
});

describe("measuring real pixels", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "aa-frame-screen-"));
    // A card: a large flat light panel with dark glyph-sized marks on it.
    const card = Buffer.alloc(1024 * 1536 * 3, 245);
    for (let y = 200; y < 1300; y += 40) {
      for (let x = 100; x < 900; x++) {
        for (let d = 0; d < 12; d++) {
          const i = ((y + d) * 1024 + x) * 3;
          if (x % 7 < 4) { card[i] = 20; card[i + 1] = 30; card[i + 2] = 25; }
        }
      }
    }
    await sharp(card, { raw: { width: 1024, height: 1536, channels: 3 } })
      .png().toFile(join(dir, "card.png"));

    // A photograph: structure at several scales, which is what survives a
    // downscale. Grain alone does not -- see the limitation test below.
    const photo = Buffer.alloc(1024 * 1536 * 3);
    for (let y = 0; y < 1536; y++) {
      for (let x = 0; x < 1024; x++) {
        const i = (y * 1024 + x) * 3;
        const big = Math.sin(x / 90) * 38 + Math.cos(y / 70) * 34;
        const mid = Math.sin((x + y) / 23) * 20;
        const grain = ((x * 7 + y * 13) % 23) - 11;
        const v = Math.max(0, Math.min(255, 118 + big + mid + grain));
        photo[i] = v; photo[i + 1] = v * 0.92; photo[i + 2] = v * 1.05;
      }
    }
    await sharp(photo, { raw: { width: 1024, height: 1536, channels: 3 } })
      .png().toFile(join(dir, "photo.png"));

    // A deliberately empty bright frame: the known false positive.
    const empty = Buffer.alloc(1024 * 1536 * 3, 236);
    for (let i = 0; i < empty.length; i += 3) {
      const g = (i % 17) - 8;
      empty[i] = 236 + g; empty[i + 1] = 236 + g; empty[i + 2] = 236 + g;
    }
    await sharp(empty, { raw: { width: 1024, height: 1536, channels: 3 } })
      .png().toFile(join(dir, "empty.png"));
  }, 60_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("reads a flat light card as card-led", async () => {
    const got = await measureComposition(join(dir, "card.png"));
    expect(got.flatLightFraction).toBeGreaterThan(CARD_LED_AT);
    expect(frameVerdict(got)).toBe("card_led");
  });

  it("reads a photograph as image-led, grain and all", async () => {
    // The point of measuring flatness rather than brightness: a light
    // photograph is still not flat.
    const got = await measureComposition(join(dir, "photo.png"));
    expect(got.flatLightFraction).toBeLessThan(IMAGE_LED_UNDER);
    expect(frameVerdict(got)).toBe("image_led");
  });

  it("calls a deliberately empty bright frame a card, which is the known limit", async () => {
    // Flatness is measured after a downscale, so it is large-scale uniformity.
    // A clear sky, a plain wall or seamless-paper product shot would read this
    // way. Pinned rather than left to be rediscovered as a bug -- and
    // survivable only because nothing here refuses a render.
    const got = await measureComposition(join(dir, "empty.png"));
    expect(frameVerdict(got)).toBe("card_led");
  });

  it("reports the real pixel dimensions, not the downscale", async () => {
    const got = await measureComposition(join(dir, "card.png"));
    expect(got).toMatchObject({ width: 1024, height: 1536 });
  });
});
