import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { placeLogo } from "./logo.js";

const render = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 4, background: "#efece6" } }).png().toBuffer();

const logo = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 4, background: "#1b2a3a" } }).png().toBuffer();

describe("logo placement", () => {
  it("returns an image the same size as the render", async () => {
    const { result, placed } = await placeLogo(await render(1024, 1536), await logo(600, 200));
    expect(placed).toBe(true);
    const meta = await sharp(result.bytes).metadata();
    expect(meta.width).toBe(1024);
    expect(meta.height).toBe(1536);
  });

  it("puts the logo inside the reserved band at the foot, not over the copy", async () => {
    const base = await render(1024, 1536);
    const { result } = await placeLogo(base, await logo(600, 200));

    // The band is the bottom 15%: everything above it must be untouched.
    const bandTop = Math.round(1536 * 0.85);
    const above = await sharp(result.bytes)
      .extract({ left: 0, top: 0, width: 1024, height: bandTop - 4 })
      .raw()
      .toBuffer();
    const untouched = await sharp(base)
      .extract({ left: 0, top: 0, width: 1024, height: bandTop - 4 })
      .raw()
      .toBuffer();
    expect(above.equals(untouched)).toBe(true);

    // And something was actually drawn in the band.
    const band = await sharp(result.bytes)
      .extract({ left: 0, top: bandTop, width: 1024, height: 1536 - bandTop })
      .raw()
      .toBuffer();
    const bandBefore = await sharp(base)
      .extract({ left: 0, top: bandTop, width: 1024, height: 1536 - bandTop })
      .raw()
      .toBuffer();
    expect(band.equals(bandBefore)).toBe(false);
  });

  it("never enlarges a small logo", async () => {
    // A 40x20 mark must stay 40x20, not be blown up to fill the band.
    const base = await render(1024, 1536);
    const { result } = await placeLogo(base, await logo(40, 20));
    const band = Math.round(1536 * 0.15);
    // Count non-background pixels; an enlarged logo would cover far more.
    const { data, info } = await sharp(result.bytes)
      .extract({ left: 0, top: 1536 - band, width: 1024, height: band })
      .raw()
      .toBuffer({ resolveWithObject: true });
    let dark = 0;
    for (let i = 0; i < data.length; i += info.channels) if (data[i]! < 100) dark += 1;
    expect(dark).toBeLessThan(40 * 20 * 1.5);
    expect(dark).toBeGreaterThan(0);
  });

  it("keeps the render when the logo is unreadable rather than losing it", async () => {
    const base = await render(1024, 1536);
    const { result, placed, reason } = await placeLogo(base, Buffer.from("not an image"));
    expect(placed).toBe(false);
    expect(reason).toBeTruthy();
    // The paid-for render survives.
    expect(result.bytes.equals(base)).toBe(true);
  });

  it("handles a landscape render as well as a portrait one", async () => {
    const { result, placed } = await placeLogo(await render(1536, 1024), await logo(600, 200));
    expect(placed).toBe(true);
    const meta = await sharp(result.bytes).metadata();
    expect(meta.width).toBe(1536);
    expect(meta.height).toBe(1024);
  });
});
