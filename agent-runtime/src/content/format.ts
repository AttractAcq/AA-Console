/**
 * What shape a piece of content runs in, and which media types can carry it.
 *
 * The same values as the console's src/lib/contentFormat.ts and the
 * content_format enum. The runtime is a separate package and cannot import
 * the console's copy, so this is a deliberate mirror rather than an
 * accident — and the rule it exists to state is also written as a check
 * constraint in format_fits_media(), which is the copy that actually holds.
 */

export const CONTENT_FORMATS = ["single", "carousel", "story", "reel"] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];

export const PLATFORM_FORMATS: Record<string, readonly ContentFormat[]> = {
  instagram: ["single", "carousel", "story", "reel"],
  facebook: ["single", "carousel", "story", "reel"],
  tiktok: ["single", "carousel", "reel"],
  linkedin: ["single", "carousel"],
  youtube: ["single", "reel"],
};

export function platformAllowsFormat(platform: string, format: string): boolean {
  return Object.hasOwn(PLATFORM_FORMATS, platform) && PLATFORM_FORMATS[platform]!.includes(format as ContentFormat);
}

export function isContentFormat(value: unknown): value is ContentFormat {
  return typeof value === "string" && (CONTENT_FORMATS as readonly string[]).includes(value);
}

/** Whether a format is made of ordered frames rather than one file. A reel's frames are shots. */
export function isMultiFrame(format: string): boolean {
  return format === "carousel" || format === "story" || format === "reel";
}

/**
 * Whether this format can carry this media type.
 *
 * A carousel is images: a swipeable set of clips is a story, not a carousel.
 * A story is either. A reel is a video. Single carries anything, including
 * text, which has no frames and so has no other shape available to it.
 *
 * Mirrors format_fits_media().
 */
export function formatFitsMedia(format: string, mediaType: string): boolean {
  if (format === "carousel") return mediaType === "image";
  if (format === "story") return mediaType === "image" || mediaType === "video";
  if (format === "reel") return mediaType === "video";
  return format === "single";
}

/**
 * The format to file, given what the model asked for.
 *
 * A model that returns "carousel" for a video has contradicted itself, and
 * the pairing is refused rather than guessed at: silently rewriting the
 * media type would produce an image the ideation never proposed, and
 * silently keeping it would hit the check constraint at insert and lose the
 * whole batch. Falling back to 'single' loses one idea's shape and keeps the
 * other twenty-four.
 */
export function coerceFormat(format: unknown, mediaType: string): ContentFormat {
  if (!isContentFormat(format)) return "single";
  return formatFitsMedia(format, mediaType) ? format : "single";
}

/** Which formats an idea of this media type may be proposed in. */
export function formatsForMedia(mediaType: string): ContentFormat[] {
  return CONTENT_FORMATS.filter((f) => formatFitsMedia(f, mediaType));
}

/**
 * How many frames a set may have.
 *
 * Here rather than in creative_build, because two places now need them: the
 * brief agent, which writes the plan, and the render, which builds to it. A
 * bound that lives beside only one of them is a bound the other can quietly
 * disagree with.
 *
 * Fewer than two is not a carousel, it is two posts. Meta caps a carousel at
 * ten, and nobody swipes that far anyway.
 */
export const MIN_FRAMES = 2;
export const MAX_FRAMES = 10;

/**
 * Why this ordered plan cannot be briefed from, or null if it can.
 *
 * Mirrors frame_plan_is_usable() in migration 113, which is the copy that
 * holds. A blank line is refused rather than dropped here: the model was
 * asked for N frames and returned one it had nothing to say about, and
 * silently shrinking the set would hide that.
 */
export function framePlanProblem(lines: readonly string[]): string | null {
  if (lines.length < MIN_FRAMES) {
    return `A frame set needs at least ${MIN_FRAMES} frames; this plan has ${lines.length}.`;
  }
  if (lines.length > MAX_FRAMES) {
    return `${MAX_FRAMES} frames is the limit; this plan has ${lines.length}.`;
  }

  const blank = lines.findIndex((line) => line.trim().length === 0);
  if (blank >= 0) return `Frame ${blank + 1} of the plan says nothing about what that frame is for.`;
  return null;
}
