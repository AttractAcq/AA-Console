import sharp from "sharp";

/**
 * A reel frame is 9:16. The image API cannot make one.
 *
 * It offers 1024x1536, 1024x1024 and 1536x1024 — 2:3, 1:1 and 3:2. The
 * closest vertical, 2:3, is 0.667 against a reel's 0.5625, so a still
 * rendered at 1024x1536 is too wide for the thing it is being made for.
 *
 * The previous reel converter repeated the top and bottom image rows. That
 * protected text at the side edges, but documentary shots repeated a shirt
 * or desk into a visible striped band. Source footage now contains no text;
 * a centred crop removes 80 pixels from each side of a 1024x1536 frame.
 *
 * Only reel opening stills come through here. A carousel, a story and a
 * single are legitimately 2:3 or square and are left exactly as rendered.
 */

export const REEL_WIDTH = 1080;
export const REEL_HEIGHT = 1920;

/**
 * What the renderer is told.
 *
 * The important action must survive the narrow side crop.
 */
export const REEL_SAFE_AREA_NOTE =
  "Vertical 9:16 reel frame. The image renderer supplies a slightly wider 2:3 canvas, " +
  "so the outer 10% of its left and right edges will be cropped to 9:16. " +
  "Keep every important person, hand, prop and action inside the central 80%. " +
  "Do not put text, logos or graphic elements anywhere in the source frame.";

export interface VerticalFrame {
  bytes: Buffer;
  contentType: string;
  extension: string;
}

/**
 * Centre-crop to 9:16, then scale to 1080x1920. Only reel keyframes use this;
 * static ads, carousels and stories retain their existing image treatment.
 */
export async function toReelFrame(bytes: Buffer): Promise<VerticalFrame> {
  const { width, height } = await sharp(bytes).metadata();
  if (!width || !height) {
    throw new Error("Could not read the rendered still's dimensions, so it was not made 9:16.");
  }

  const out = await sharp(bytes).resize(REEL_WIDTH, REEL_HEIGHT, { fit: "cover", position: "centre" }).png().toBuffer();
  return { bytes: out, contentType: "image/png", extension: "png" };
}
