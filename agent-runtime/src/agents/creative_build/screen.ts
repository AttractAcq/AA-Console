/**
 * How much of a generated image is card, and how much is picture.
 *
 * THE DEFECT THIS MEASURES, AND WHY THE CONCEPT STAGE CANNOT SEE IT
 *
 * `conceptProblem` closed the route where a concept could ask for type on a
 * colour: it requires a background and a treatment that is not
 * typography-only. That worked -- no post-schema concept declares itself
 * typography any more. The renders did not follow.
 *
 * Auditing production bears that out. One client's post-fix output is, image
 * after image, a dense white text card with photography arranged around it as
 * a border, a backdrop or a prop. Every one satisfies the concept rules
 * truthfully: there IS a background, the treatment IS photographic. The model
 * found the nearest thing that satisfies every rule and still avoids drawing a
 * picture. A concept-stage validator cannot catch that, because the words it
 * reads are honest; the composition is where the defect lives.
 *
 * WHAT THIS DOES NOT CLAIM
 *
 * It does not say a card is wrong. A worksheet lead magnet genuinely is a
 * document, and a client may want the card look. It measures, and leaves the
 * judgement to the person who owns the brand -- which is why nothing here
 * refuses a render. The number is recorded so the trend is visible, which is
 * the thing that was missing: both earlier attempts to measure this defect
 * (concepts declaring no imagery, printed matter named in the subject) were
 * proxies read off the concept text, and both said the problem had gone while
 * the renders said otherwise.
 *
 * THE MEASUREMENT
 *
 * A card is a large area of flat, light stock. A photograph almost never is:
 * even a plain wall carries gradient and grain. So: downscale, take small
 * blocks, and count the fraction that are both flat (low standard deviation)
 * and light. Text glyphs sit inside such a block as high-frequency detail, so
 * the glyphs themselves are not counted -- the card AROUND them is, which is
 * what makes this robust to how much copy a card carries.
 *
 * Measured on real production output, the separation is total:
 *
 *   image-led ads (another client, same validator)   0.0%, 0.0%, 0.3%
 *   card-led renders (the client with the defect)    21.8% .. 46.3%
 *
 * No overlap, and two orders of magnitude between the groups. The thresholds
 * below sit in that gap rather than at a number chosen by feel, and the test
 * pins the real figures so a future change has to argue with them.
 *
 * WHAT IT WOULD GET WRONG
 *
 * Flatness is measured after a downscale, so it is large-scale uniformity, not
 * grain. A real photograph survives that because it has structure at every
 * scale -- edges, objects, depth. A deliberately empty bright one would not: a
 * clear sky, a plain white wall, a minimalist product on seamless paper would
 * all read as card. That is a known limitation and a test pins it, so nobody
 * rediscovers it as a bug.
 *
 * It is survivable only because nothing here refuses a render. If this ever
 * becomes a gate, that case has to be answered first.
 */

import sharp from "sharp";

/** Downscale target. Small enough to be cheap, large enough that blocks mean something. */
const W = 96;
const H = 144;
/** Block edge in pixels of the downscaled image. */
const BLOCK = 4;
/** A block this uniform is flat stock rather than photographic detail. */
const FLAT_SD = 6;
/** ...and this light is card rather than shadow. */
const LIGHT_MEAN = 170;

/**
 * Above this, the frame is mostly card. Set at a tenth: three times the
 * highest image-led render measured (0.3%) and half the lowest card-led one
 * (21.8%), so neither group is near it.
 */
export const CARD_LED_AT = 0.10;
/** Below this, nothing is in doubt; between the two, say so rather than guess. */
export const IMAGE_LED_UNDER = 0.05;

export type FrameComposition = {
  /** Fraction of the frame that is flat, light stock. */
  flatLightFraction: number;
  width: number;
  height: number;
};

export type FrameVerdict = "image_led" | "borderline" | "card_led";

/**
 * What this composition is, by the measurement alone.
 *
 * Deliberately a label and not a refusal. Whether a card is the right
 * deliverable is a brand decision, and a screen that threw away paid
 * generations on a threshold calibrated from two clients would be making that
 * decision in the wrong place -- the same mistake, one layer down, as the
 * prohibition that produced these cards in the first place.
 */
export function frameVerdict(m: FrameComposition): FrameVerdict {
  if (m.flatLightFraction >= CARD_LED_AT) return "card_led";
  if (m.flatLightFraction < IMAGE_LED_UNDER) return "image_led";
  return "borderline";
}

/** One line for the job's event log, where a person reading the job will see it. */
export function compositionNote(m: FrameComposition): string {
  const pct = (m.flatLightFraction * 100).toFixed(1);
  switch (frameVerdict(m)) {
    case "card_led":
      return `This render is ${pct}% flat card stock: a text card with imagery around it rather than an image. Intended for a worksheet or document; worth a look otherwise.`;
    case "borderline":
      return `This render is ${pct}% flat card stock, between an image and a card.`;
    default:
      return `This render is ${pct}% flat card stock: image-led.`;
  }
}

/**
 * Measure a rendered image, from its bytes or from a file.
 *
 * Reports and judges nothing, so the judgement above can be tested against
 * figures that would be slow or expensive to produce for real.
 */
export async function measureComposition(
  source: string | Buffer,
): Promise<FrameComposition> {
  // A Buffer so a freshly rendered image can be measured before it is stored,
  // with no temp file; a path so tests can use fixtures on disk.
  const image = sharp(source);
  const meta = await image.metadata();
  const { data } = await image
    .greyscale()
    .resize(W, H, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let flat = 0;
  let total = 0;
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
      if (sd < FLAT_SD && mean > LIGHT_MEAN) flat++;
    }
  }
  return {
    flatLightFraction: total === 0 ? 0 : flat / total,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
  };
}
