import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { REEL_HEIGHT, REEL_SAFE_AREA_NOTE, REEL_WIDTH, toReelFrame } from "./vertical.js";

const solid = (w: number, h: number, colour = "#0F4C5C") =>
  sharp({ create: { width: w, height: h, channels: 3, background: colour } }).png().toBuffer();

/** A band of a different colour down one edge, to show which pixels survived. */
async function withEdgeMarks(w: number, h: number): Promise<Buffer> {
  const band = await sharp({ create: { width: 40, height: h, channels: 3, background: "#C3DB5A" } })
    .png()
    .toBuffer();
  return sharp({ create: { width: w, height: h, channels: 3, background: "#0F4C5C" } })
    .composite([
      { input: band, left: 0, top: 0 },
      { input: band, left: w - 40, top: 0 },
    ])
    .png()
    .toBuffer();
}

const pixel = async (bytes: Buffer, x: number, y: number) => {
  const { data } = await sharp(bytes).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  return [data[0], data[1], data[2]];
};

describe("a reel frame is 9:16", () => {
  it("turns the 2:3 the image API actually returns into 1080x1920", async () => {
    const out = await toReelFrame(await solid(1024, 1536));
    const meta = await sharp(out.bytes).metadata();
    expect(meta.width).toBe(REEL_WIDTH);
    expect(meta.height).toBe(REEL_HEIGHT);
    expect(REEL_WIDTH / REEL_HEIGHT).toBeCloseTo(9 / 16, 5);
    expect(out.contentType).toBe("image/png");
    expect(out.extension).toBe("png");
  });

  it("takes the width off both sides, not one", async () => {
    // 1024x1536 keeps 864 of the width, so 80px goes from each edge. The
    // 40px marker bands sit inside that and must both be gone.
    const out = await toReelFrame(await withEdgeMarks(1024, 1536));
    const [, g] = await pixel(out.bytes, 2, 960);
    const [, gRight] = await pixel(out.bytes, REEL_WIDTH - 3, 960);
    // Lime bands (high green) gone; the dark teal body (low green) remains.
    expect(g).toBeLessThan(120);
    expect(gRight).toBeLessThan(120);
  });

  it("keeps the middle, which is what the safe-area note protects", async () => {
    const centre = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#C3DB5A" } }).png().toBuffer();
    const source = await sharp({ create: { width: 1024, height: 1536, channels: 3, background: "#0F4C5C" } })
      .composite([{ input: centre, left: 412, top: 668 }])
      .png()
      .toBuffer();
    const out = await toReelFrame(source);
    const [, g] = await pixel(out.bytes, REEL_WIDTH / 2, REEL_HEIGHT / 2);
    expect(g).toBeGreaterThan(180);
  });

  it("scales an image already 9:16 rather than cropping it again", async () => {
    const out = await toReelFrame(await withEdgeMarks(540, 960));
    const meta = await sharp(out.bytes).metadata();
    expect(meta.width).toBe(REEL_WIDTH);
    expect(meta.height).toBe(REEL_HEIGHT);
    // Already the right shape, so the edge bands survive the scale.
    const [, g] = await pixel(out.bytes, 10, 960);
    expect(g).toBeGreaterThan(180);
  });

  it("handles a square render without stretching it to 9:16", async () => {
    const out = await toReelFrame(await solid(1024, 1024));
    const meta = await sharp(out.bytes).metadata();
    expect(meta.width).toBe(REEL_WIDTH);
    expect(meta.height).toBe(REEL_HEIGHT);
  });

  it("refuses bytes it cannot measure rather than storing a wrong shape", async () => {
    await expect(toReelFrame(Buffer.from("not an image"))).rejects.toThrow();
  });

  it("tells the renderer in shares of the width, not pixels", async () => {
    // A pixel figure would go stale the moment the render size changes.
    expect(REEL_SAFE_AREA_NOTE).toMatch(/9:16/);
    expect(REEL_SAFE_AREA_NOTE).toMatch(/80% of the width/);
    expect(REEL_SAFE_AREA_NOTE).not.toMatch(/\d{3,4}\s*px|\d{3,4}x\d{3,4}/);
  });
});
