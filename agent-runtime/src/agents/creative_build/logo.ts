// Placing the client's real logo onto a finished render.
//
// The image model is never asked to draw it. A diffusion model approximates a
// wordmark — close, wrong, and confidently so — and an approximated logo on a
// real company's advertising is a false mark, not a near miss. So the render
// is told to leave a clear band at the foot and the actual file goes in here,
// pixel for pixel.
//
// This is deliberately dumb: centre it in the reserved band, scale it to fit,
// never enlarge it. Anything cleverer would be guessing at a layout the
// renderer already decided.

import sharp from "sharp";
import { logger } from "../../logging/logger.js";

/** Must match the band the render prompt reserves. */
const BAND_FRACTION = 0.15;
/** Of that band, how much the logo may occupy — the rest is breathing room. */
const LOGO_HEIGHT_OF_BAND = 0.45;
const LOGO_MAX_WIDTH_OF_IMAGE = 0.4;

export interface Composited {
  bytes: Buffer;
  contentType: string;
  extension: string;
}

/**
 * Returns the image with the logo placed, or the original if it cannot be.
 *
 * A logo that fails to composite must not lose the render: the asset is still
 * worth having without it, and a failed build here would throw away an image
 * that has already been paid for.
 */
export async function placeLogo(
  base: Buffer,
  logo: Buffer,
): Promise<{ result: Composited; placed: boolean; reason?: string }> {
  const original: Composited = { bytes: base, contentType: "image/png", extension: "png" };

  try {
    const image = sharp(base);
    const { width, height } = await image.metadata();
    if (!width || !height) {
      return { result: original, placed: false, reason: "could not read the render's dimensions" };
    }

    const band = Math.round(height * BAND_FRACTION);
    const maxHeight = Math.round(band * LOGO_HEIGHT_OF_BAND);
    const maxWidth = Math.round(width * LOGO_MAX_WIDTH_OF_IMAGE);

    // Flattening is deliberately not done: a logo with transparency should
    // keep it, so it sits on whatever ground the render produced.
    const scaled = await sharp(logo)
      .resize({ width: maxWidth, height: maxHeight, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();

    const scaledMeta = await sharp(scaled).metadata();
    if (!scaledMeta.width || !scaledMeta.height) {
      return { result: original, placed: false, reason: "could not read the logo's dimensions" };
    }

    const left = Math.round((width - scaledMeta.width) / 2);
    const top = Math.round(height - band / 2 - scaledMeta.height / 2);

    const bytes = await image
      .composite([{ input: scaled, left, top: Math.min(top, height - scaledMeta.height) }])
      .png()
      .toBuffer();

    return { result: { bytes, contentType: "image/png", extension: "png" }, placed: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error("logo_composite_failed", { reason });
    return { result: original, placed: false, reason };
  }
}
