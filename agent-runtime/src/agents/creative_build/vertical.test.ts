import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { REEL_HEIGHT, REEL_SAFE_AREA_NOTE, REEL_WIDTH, toReelFrame } from "./vertical.js";

const BODY = "#0F4C5C";
const MARK = "#C3DB5A";

const solid = (w: number, h: number, colour = BODY) =>
  sharp({ create: { width: w, height: h, channels: 3, background: colour } }).png().toBuffer();

/** Marker bands down the left and right edges, to show whether width survived. */
async function withSideMarks(w: number, h: number): Promise<Buffer> {
  const band = await sharp({ create: { width: 30, height: h, channels: 3, background: MARK } }).png().toBuffer();
  return sharp({ create: { width: w, height: h, channels: 3, background: BODY } })
    .composite([{ input: band, left: 0, top: 0 }, { input: band, left: w - 30, top: 0 }])
    .png()
    .toBuffer();
}

const pixel = async (bytes: Buffer, x: number, y: number) => {
  const { data } = await sharp(bytes)
    .extract({ left: x, top: y, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { r: data[0]!, g: data[1]!, b: data[2]! };
};

describe("a reel frame is 9:16, and nothing is lost getting there", () => {
  it("turns the 2:3 the image API actually returns into 1080x1920", async () => {
    const out = await toReelFrame(await solid(1024, 1536));
    const meta = await sharp(out.bytes).metadata();
    expect(meta.width).toBe(REEL_WIDTH);
    expect(meta.height).toBe(REEL_HEIGHT);
    expect(REEL_WIDTH / REEL_HEIGHT).toBeCloseTo(9 / 16, 5);
    expect(out.contentType).toBe("image/png");
  });

  it("keeps both edges of the width, which cropping did not", async () => {
    // This is the regression. The first attempt cropped 80px from each side
    // and took a letter off each end of a full-width headline. Extending
    // cannot: the marker bands at x=0 and x=width-1 must both survive.
    const out = await toReelFrame(await withSideMarks(1024, 1536));
    const left = await pixel(out.bytes, 1, REEL_HEIGHT / 2);
    const right = await pixel(out.bytes, REEL_WIDTH - 2, REEL_HEIGHT / 2);
    expect(left.g).toBeGreaterThan(180);
    expect(right.g).toBeGreaterThan(180);
  });

  it("adds the height evenly, so the composition stays centred", async () => {
    // A 2:3 frame gains 284 rows, 142 each end; after the scale to 1920 that
    // is ~150. The original top row should sit around there, not at y=0.
    const top = await sharp({ create: { width: 1024, height: 40, channels: 3, background: MARK } }).png().toBuffer();
    const source = await sharp({ create: { width: 1024, height: 1536, channels: 3, background: BODY } })
      .composite([{ input: top, left: 0, top: 0 }])
      .png()
      .toBuffer();
    const out = await toReelFrame(source);
    const inPadding = await pixel(out.bytes, 540, 20);
    const atOriginalTop = await pixel(out.bytes, 540, 170);
    // The padding copies the edge row, so it is the marker colour too — the
    // point is that the marker band is thicker than it was, not displaced.
    expect(inPadding.g).toBeGreaterThan(180);
    expect(atOriginalTop.g).toBeGreaterThan(180);
    const belowIt = await pixel(out.bytes, 540, 400);
    expect(belowIt.g).toBeLessThan(120);
  });

  it("pads width instead when a frame is taller than 9:16", async () => {
    const out = await toReelFrame(await solid(500, 1600));
    const meta = await sharp(out.bytes).metadata();
    expect(meta.width).toBe(REEL_WIDTH);
    expect(meta.height).toBe(REEL_HEIGHT);
  });

  it("only scales a frame already 9:16", async () => {
    const out = await toReelFrame(await withSideMarks(540, 960));
    const left = await pixel(out.bytes, 1, 960);
    expect(left.g).toBeGreaterThan(180);
    const meta = await sharp(out.bytes).metadata();
    expect(meta.width).toBe(REEL_WIDTH);
    expect(meta.height).toBe(REEL_HEIGHT);
  });

  it("handles a square render", async () => {
    const out = await toReelFrame(await solid(1024, 1024));
    const meta = await sharp(out.bytes).metadata();
    expect(meta.width).toBe(REEL_WIDTH);
    expect(meta.height).toBe(REEL_HEIGHT);
  });

  it("refuses bytes it cannot measure rather than storing a wrong shape", async () => {
    await expect(toReelFrame(Buffer.from("not an image"))).rejects.toThrow();
  });

  it("asks for clean top and bottom edges, and does not ask for an inset", async () => {
    // The inset is what the first attempt asked for and did not get. Asking
    // again, harder, would be arguing with the model once per render.
    expect(REEL_SAFE_AREA_NOTE).toMatch(/9:16/);
    expect(REEL_SAFE_AREA_NOTE).toMatch(/top and bottom edges as clean background/);
    expect(REEL_SAFE_AREA_NOTE).toMatch(/full width is yours/i);
    expect(REEL_SAFE_AREA_NOTE).not.toMatch(/middle \d+%|inside the middle/i);
  });
});
