/**
 * The formats one finished asset can become.
 *
 * Each entry says what the derivative *is*, and which media_type its brief
 * carries — because that decides which fields Brief Studio asks for and which
 * production route it can take afterwards. A reel brief is a video brief and
 * goes to an editor; a text post brief is a text brief and the AI route can
 * build it outright.
 *
 * Nothing here claims to cut video. A reel derived from a static ad is a brief
 * for a reel, which a person or a later tool makes.
 */
export interface RepurposeFormat {
  key: string;
  label: string;
  mediaType: "image" | "text" | "video";
  /** What the derivative must do differently from the root. */
  direction: string;
}

export const FORMATS: RepurposeFormat[] = [
  {
    key: "reel",
    label: "Reel",
    mediaType: "video",
    direction:
      "A vertical short-form video, 20-45 seconds. The root's argument compressed to its single sharpest beat, opening on movement or a spoken line rather than a title card.",
  },
  {
    key: "short",
    label: "Short",
    mediaType: "video",
    direction:
      "Under 30 seconds, one idea only. Harder cut than the reel: no setup, the claim lands in the first three seconds.",
  },
  {
    key: "story_clips",
    label: "Story clips",
    mediaType: "video",
    direction:
      "Three to five sequential 5-8 second frames, each readable on mute and standing alone if someone taps in halfway.",
  },
  {
    key: "carousel",
    label: "Carousel",
    mediaType: "image",
    direction:
      "Six to eight frames. Frame one earns the swipe, the middle frames carry one point each, the last asks for the action. Say what each frame contains.",
  },
  {
    key: "quote_graphic",
    label: "Quote graphic",
    mediaType: "image",
    direction:
      "A single still built around one line lifted from the root — the line a reader would repeat. No explanation on the image.",
  },
  {
    key: "text_post",
    label: "Text post",
    mediaType: "text",
    direction:
      "A standalone written post that works with no image. The root's argument in the buyer's own register, opening on the hook.",
  },
  {
    key: "email",
    label: "Email",
    mediaType: "text",
    direction:
      "Subject line, preview line and body. Written to one person who already knows the business, not to an audience.",
  },
  {
    key: "ad_variation",
    label: "Ad variation",
    mediaType: "image",
    direction:
      "The same offer as the root with a different entry point — a different hook and first frame, testing one variable, not a redesign.",
  },
];

const BY_KEY = new Map(FORMATS.map((f) => [f.key, f]));

export function resolveFormats(requested: unknown): {
  formats: RepurposeFormat[];
  unknown: string[];
} {
  const list = Array.isArray(requested) ? requested.map(String) : [];
  const formats: RepurposeFormat[] = [];
  const unknownKeys: string[] = [];
  for (const key of list) {
    const found = BY_KEY.get(key);
    if (found) formats.push(found);
    else unknownKeys.push(key);
  }
  return { formats, unknown: unknownKeys };
}
