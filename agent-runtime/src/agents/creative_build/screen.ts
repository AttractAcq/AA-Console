/** Pixel evidence for reviewing a finished creative. This is observational except for
 * the narrow almost-empty-frame check. Flat stock alone cannot prove that an
 * image is a text card: dark product photographs can be mostly flat too. */
import sharp from "sharp";

const W = 96;
const H = 144;
const BLOCK = 4;
const FLAT_SD = 6;
const LIGHT_MEAN = 170;

export const CARD_LED_AT = 0.10;
export const IMAGE_LED_UNDER = 0.05;
/** Below this, a dark card can disappear from the light-only measurement. */
export const DARK_REVIEW_AT = 0.15;
/** Calibrated against a nearly empty story frame (97.5%) and a real object
 * scene (84.6%). This is deliberately much narrower than card detection. */
export const BLANK_LIGHT_AT = 0.95;

export type FrameComposition = {
  flatLightFraction: number;
  flatDarkFraction: number;
  meanLuminance: number;
  width: number;
  height: number;
};

export type FrameVerdict = "image_led" | "borderline" | "card_led" | "dark_review";

export function isNearlyBlank(m: FrameComposition): boolean {
  return m.flatLightFraction >= BLANK_LIGHT_AT && m.meanLuminance >= 235;
}

export function frameVerdict(m: FrameComposition): FrameVerdict {
  if (m.flatLightFraction >= CARD_LED_AT) return "card_led";
  if (m.flatDarkFraction >= DARK_REVIEW_AT) return "dark_review";
  if (m.flatLightFraction < IMAGE_LED_UNDER) return "image_led";
  return "borderline";
}

export function compositionNote(m: FrameComposition): string {
  const light = (m.flatLightFraction * 100).toFixed(1);
  const dark = (m.flatDarkFraction * 100).toFixed(1);
  if (isNearlyBlank(m)) return `This render is ${light}% flat light area and appears nearly blank. It needs a new frame.`;
  switch (frameVerdict(m)) {
    case "card_led":
      return `This render is ${light}% flat light area: possible text card. Review against the brief; a light photograph can also read this way.`;
    case "dark_review":
      return `This render is ${dark}% flat dark area: review for a dark text card. Dark photography can have the same measurement.`;
    case "borderline":
      return `This render is ${light}% flat light area, between an image and a card by this measurement.`;
    default:
      return `This render is ${light}% flat light area and ${dark}% flat dark area: image-led by this measurement.`;
  }
}

export async function measureComposition(source: string | Buffer): Promise<FrameComposition> {
  const image = sharp(source);
  const meta = await image.metadata();
  const { data } = await image.greyscale().resize(W, H, { fit: "fill" }).raw()
    .toBuffer({ resolveWithObject: true });
  let flatLight = 0;
  let flatDark = 0;
  let total = 0;
  let luminance = 0;
  for (let by = 0; by + BLOCK <= H; by += BLOCK) {
    for (let bx = 0; bx + BLOCK <= W; bx += BLOCK) {
      let sum = 0;
      let sumSquares = 0;
      for (let y = 0; y < BLOCK; y++) {
        for (let x = 0; x < BLOCK; x++) {
          const v = data[(by + y) * W + (bx + x)]!;
          sum += v;
          sumSquares += v * v;
        }
      }
      const n = BLOCK * BLOCK;
      const mean = sum / n;
      const sd = Math.sqrt(Math.max(0, sumSquares / n - mean * mean));
      total++;
      luminance += sum;
      if (sd < FLAT_SD) {
        if (mean > LIGHT_MEAN) flatLight++;
        else flatDark++;
      }
    }
  }
  return {
    flatLightFraction: flatLight / total,
    flatDarkFraction: flatDark / total,
    meanLuminance: luminance / (total * BLOCK * BLOCK),
    width: meta.width ?? 0,
    height: meta.height ?? 0,
  };
}
