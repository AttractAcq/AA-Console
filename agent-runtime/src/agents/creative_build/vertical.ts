import sharp from "sharp";

/**
 * A reel frame is 9:16. The image API cannot make one.
 *
 * It offers 1024x1536, 1024x1024 and 1536x1024 — 2:3, 1:1 and 3:2. The
 * closest vertical, 2:3, is 0.667 against a reel's 0.5625, so a still
 * rendered at 1024x1536 is visibly too wide and every frame AA-0119
 * produced was the wrong shape for the thing it was being made for.
 *
 * Two halves, and both are needed. This module crops the render to 9:16 and
 * scales it to the 1080x1920 the platforms expect, so what lands in storage
 * is already a reel frame and Higgsfield animates the right rectangle.
 * REEL_SAFE_AREA_NOTE goes into the prompt so the composition survives that
 * crop: the first stills put headlines across the full width, and a centre
 * crop alone would have taken the ends off "WE BUILD IT AS ONE CHAIN" and
 * clipped the last card out of the frame.
 *
 * Only reel opening stills come through here. A carousel, a story and a
 * single are legitimately 2:3 or square and are left exactly as rendered.
 */

export const REEL_WIDTH = 1080;
export const REEL_HEIGHT = 1920;
const REEL_RATIO = 9 / 16;

/**
 * What the renderer is told, so the crop costs nothing.
 *
 * Stated as a share of the width rather than in pixels: the model is not
 * composing in pixels, and a fraction survives a change of render size.
 * 80% rather than the 84.4% actually kept, so a composition that sits right
 * on the line still has somewhere to go.
 */
export const REEL_SAFE_AREA_NOTE =
  "Vertical 9:16 framing. This image is cropped to a tall 9:16 reel frame afterwards, " +
  "losing roughly 8% of the width from each side. Keep every piece of text, every " +
  "logo and the whole of the main subject inside the middle 80% of the width. " +
  "Background, texture and shadow may run to the edges; nothing that has to be read " +
  "or recognised may.";

export interface VerticalFrame {
  bytes: Buffer;
  contentType: string;
  extension: string;
}

/**
 * Centre-crop to 9:16, then scale to 1080x1920.
 *
 * Centre rather than top: a cold-open headline sits high and an end card
 * sits low, so there is no one edge that is safe to favour, and the note
 * above is what keeps the middle enough.
 *
 * An image already at 9:16 or taller is not cropped, only scaled — cropping
 * a correct shape to make it correct again would only lose pixels.
 */
export async function toReelFrame(bytes: Buffer): Promise<VerticalFrame> {
  const image = sharp(bytes);
  const { width, height } = await image.metadata();
  if (!width || !height) {
    throw new Error("Could not read the rendered still's dimensions, so it was not cropped to 9:16.");
  }

  const pipeline = sharp(bytes);
  const widthAtRatio = Math.round(height * REEL_RATIO);
  if (widthAtRatio < width) {
    pipeline.extract({
      left: Math.round((width - widthAtRatio) / 2),
      top: 0,
      width: widthAtRatio,
      height,
    });
  }

  const out = await pipeline
    .resize(REEL_WIDTH, REEL_HEIGHT, { fit: "fill" })
    .png()
    .toBuffer();

  return { bytes: out, contentType: "image/png", extension: "png" };
}
