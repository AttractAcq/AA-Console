/**
 * The words, assembled.
 *
 * Deterministic and no model: by the time a post is claimed the copywriter
 * has written the caption and QA has passed it, and a model rewriting it on
 * the way out would be a fourth author nobody asked for.
 *
 * This only joins what exists and refuses what will not fit. The platform's
 * limits come from the one shared module, so a limit changing is one edit.
 */

import { PLATFORM_LIMITS, type Platform } from "../content/platform-limits.js";

export interface CopyRow {
  caption?: string | null;
  hashtags?: readonly string[] | null;
  link_url?: string | null;
  first_comment?: string | null;
}

/** A hashtag, however it was written down. */
function tag(raw: string): string {
  const cleaned = raw.trim().replace(/^#+/, "");
  return cleaned ? `#${cleaned}` : "";
}

export interface Composed {
  caption: string;
  /** Where the platform ignores a body link, it goes in the first comment. */
  firstComment: string | null;
}

/**
 * Join caption, hashtags and link into what actually goes out.
 *
 * Throws rather than truncating. A caption cut off mid-sentence is worse
 * than a post that did not go out and said why: the first reaches the
 * client's audience, the second reaches a board.
 */
export function compose(platform: Platform, copy: CopyRow): Composed {
  const limits = PLATFORM_LIMITS[platform];
  const body = (copy.caption ?? "").trim();
  if (!body) throw new Error(`There is no caption for ${platform}.`);

  const tags = (copy.hashtags ?? []).map(tag).filter(Boolean).slice(0, limits.hashtags);
  const link = (copy.link_url ?? "").trim();

  const parts = [body];
  // A link in an Instagram caption is not clickable, so putting one there
  // wastes the line. It goes to the first comment instead, which is where a
  // person would put it.
  if (link && limits.linkInBody) parts.push(link);
  if (tags.length > 0) parts.push(tags.join(" "));

  const caption = parts.join("\n\n");
  if (caption.length > limits.caption) {
    throw new Error(
      `The ${platform} caption is ${caption.length} characters with its hashtags, and the limit is ${limits.caption}.`,
    );
  }

  const comment = (copy.first_comment ?? "").trim();
  const spare = link && !limits.linkInBody ? link : "";
  const firstComment = limits.firstComment
    ? [comment, spare].filter(Boolean).join("\n\n") || null
    : null;

  return { caption, firstComment };
}
