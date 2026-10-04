import sharp from "sharp";

/**
 * A reel frame is 9:16. The image API cannot make one.
 *
 * It offers 1024x1536, 1024x1024 and 1536x1024 — 2:3, 1:1 and 3:2. The
 * closest vertical, 2:3, is 0.667 against a reel's 0.5625, so a still
 * rendered at 1024x1536 is too wide for the thing it is being made for.
 *
 * This extends the frame rather than cropping it, which is the second
 * attempt. The first cropped 160px of width and asked the renderer, in the
 * prompt, to compose inside the width that survived. It did not: both test
 * stills put their headline edge to edge anyway and lost a letter at each
 * end — "WE BUILD IT AS ONE CHAIN" came back without its W or its N. A
 * model filling a canvas it has been given is a stronger instinct than a
 * sentence asking it not to, and arguing with that in the prompt is a
 * negotiation you lose quietly, one render at a time.
 *
 * Extending cannot clip anything. 1024x1536 becomes 1024x1820 by adding 142
 * rows top and bottom, then scales to 1080x1920 — one uniform 1.055x, no
 * distortion, and every pixel the renderer composed still in frame. The
 * added rows are copies of the edge rows, which on these backgrounds is a
 * continuation of the paper rather than a band.
 *
 * Only reel opening stills come through here. A carousel, a story and a
 * single are legitimately 2:3 or square and are left exactly as rendered.
 */

export const REEL_WIDTH = 1080;
export const REEL_HEIGHT = 1920;
const REEL_RATIO = 9 / 16;

/**
 * What the renderer is told.
 *
 * It no longer asks for an inset, because that is the instruction the first
 * attempt proved does not hold. It asks for the one thing extending needs:
 * that the very top and bottom rows be background, since those rows are the
 * ones copied outward. Text touching the top edge would smear upward.
 */
export const REEL_SAFE_AREA_NOTE =
  "Vertical 9:16 reel frame. The image is extended slightly at the top and bottom " +
  "afterwards to reach 9:16, by continuing whatever is already at those edges. " +
  "Leave the top and bottom edges as clean background — no text, no logo and no " +
  "part of the main subject touching them. The full width is yours to use.";

export interface VerticalFrame {
  bytes: Buffer;
  contentType: string;
  extension: string;
}

/**
 * Pad to 9:16 without losing a pixel, then scale to 1080x1920.
 *
 * A frame wider than 9:16 gains height; a frame taller than 9:16 gains
 * width. One already at 9:16 is only scaled. The padding is split evenly so
 * the composition stays centred where the renderer put it.
 */
export async function toReelFrame(bytes: Buffer): Promise<VerticalFrame> {
  const { width, height } = await sharp(bytes).metadata();
  if (!width || !height) {
    throw new Error("Could not read the rendered still's dimensions, so it was not made 9:16.");
  }

  // Two passes, not one chain. sharp applies resize before extend whatever
  // order they are called in, so chaining them pads the already-scaled frame
  // and overshoots: 1024x1536 came back 1080x2204 rather than 1080x1920.
  const ratio = width / height;
  let padded = bytes;

  if (ratio > REEL_RATIO) {
    // Too wide. Add rows rather than remove columns: nothing composed is lost.
    const extra = Math.round(width / REEL_RATIO) - height;
    const top = Math.floor(extra / 2);
    padded = await sharp(bytes).extend({ top, bottom: extra - top, extendWith: "copy" }).png().toBuffer();
  } else if (ratio < REEL_RATIO) {
    const extra = Math.round(height * REEL_RATIO) - width;
    const left = Math.floor(extra / 2);
    padded = await sharp(bytes).extend({ left, right: extra - left, extendWith: "copy" }).png().toBuffer();
  }

  const out = await sharp(padded).resize(REEL_WIDTH, REEL_HEIGHT, { fit: "fill" }).png().toBuffer();
  return { bytes: out, contentType: "image/png", extension: "png" };
}
