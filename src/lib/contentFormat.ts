/**
 * The shape a piece of content runs in.
 *
 * Separate from media_type, which says what the file IS. A story can be a
 * still or a clip; a carousel is one thing made of several images. Folding
 * these into media_type would make a video story unsayable and leave a
 * carousel's frames nowhere to go.
 *
 * Three values, not ten. The repurpose menu lists eight derivatives — reel,
 * short, quote graphic and the rest — and media_type already covers them: a
 * reel is a video, a quote graphic is an image. Only carousel and story need
 * production to behave differently, because only they are made of ordered
 * frames.
 *
 * Kept in step with the content_format enum in migration 109.
 */
export const CONTENT_FORMATS = [
  { value: "single", label: "Single", multiFrame: false },
  { value: "carousel", label: "Carousel", multiFrame: true },
  { value: "story", label: "Story", multiFrame: true },
] as const;

export type ContentFormat = (typeof CONTENT_FORMATS)[number]["value"];

/** Fewer than this is not a carousel, it is two posts. */
export const MIN_FRAMES = 2;
/** Meta caps a carousel at ten, and nobody swipes that far anyway. */
export const MAX_FRAMES = 10;

export function isMultiFrame(format: string | null | undefined): boolean {
  return CONTENT_FORMATS.some((f) => f.value === format && f.multiFrame);
}

export function formatLabel(format: string | null | undefined): string {
  const raw = (format ?? "").trim();
  return CONTENT_FORMATS.find((f) => f.value === raw)?.label ?? raw;
}

/**
 * Which media types a format can carry.
 *
 * A carousel is images — a swipeable set of clips is a story, not a
 * carousel. A story is either. Text has no frames, so it is single only.
 */
export function mediaTypesFor(format: ContentFormat): readonly string[] {
  if (format === "carousel") return ["image"];
  if (format === "story") return ["image", "video"];
  return ["image", "text", "video"];
}

export function formatAllows(format: string, mediaType: string): boolean {
  const known = CONTENT_FORMATS.find((f) => f.value === format);
  if (!known) return false;
  return mediaTypesFor(known.value).includes(mediaType);
}

/**
 * Why this frame count cannot be produced, or null if it can.
 *
 * A single asset with frames is the mirror of a carousel without them: both
 * are a format and a body of work disagreeing about what the thing is.
 */
export function frameCountProblem(format: string, frames: number): string | null {
  if (!isMultiFrame(format)) {
    return frames > 0 ? `A ${formatLabel(format).toLowerCase()} has no frames.` : null;
  }
  if (frames < MIN_FRAMES) {
    return `A ${formatLabel(format).toLowerCase()} needs at least ${MIN_FRAMES} frames; this has ${frames}.`;
  }
  if (frames > MAX_FRAMES) {
    return `${MAX_FRAMES} frames is the limit; this has ${frames}.`;
  }
  return null;
}

/**
 * The format filter, as pills.
 *
 * "All" first, because format is the second axis and most of the time you
 * are not filtering on it — an idea is an image AND a carousel, so a pill
 * row that forced a choice would hide two thirds of the bank by default.
 */
export type FormatFilterId = "all" | ContentFormat;

export const formatFilters: Array<{ id: FormatFilterId; label: string }> = [
  { id: "all", label: "All formats" },
  ...CONTENT_FORMATS.map((f) => ({ id: f.value as FormatFilterId, label: f.label })),
];

/** The one shape a story can be. Mirrors size_fits_format() in migration 116. */
export const STORY_SIZE = "1024x1536";

/**
 * Whether a render size can carry a format.
 *
 * A story is full-screen vertical and has one answer. A carousel is
 * legitimately square or portrait depending on the channel, so it is left
 * alone — only the format with a single correct answer is constrained.
 */
export function sizeFitsFormat(format: string | null | undefined, size: string): boolean {
  return format === "story" ? size === STORY_SIZE : true;
}
