/**
 * What each platform will actually accept.
 *
 * One module, because these numbers are the kind that get copied into a form,
 * a validator and an agent prompt and then diverge the first time a platform
 * changes one. The database deliberately does not hold them: a migration is
 * the wrong place to learn that Instagram moved a limit.
 *
 * src/lib/platformLimits.ts mirrors this for the browser. The two are checked
 * against each other by a test rather than by hope.
 *
 * Numbers are the documented public limits, and conservative where a platform
 * publishes a range. A caption that fits here fits the platform; a caption the
 * platform would take and this rejects costs a person a few characters, which
 * is the cheaper way to be wrong.
 */

// ---- shared region: byte-identical with the mirror; a test enforces it ----
export const PLATFORMS = ["facebook", "instagram", "tiktok", "linkedin", "youtube"] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface PlatformLimits {
  /** Characters in the caption or body. */
  caption: number;
  /** How many hashtags the platform counts before it stops caring, or starts penalising. */
  hashtags: number;
  /** Characters of alt text, where the platform has it at all. */
  altText: number | null;
  /** Whether a link in the body is useful, as opposed to ignored or penalised. */
  linkInBody: boolean;
  /** Whether a first comment is a thing on this platform. */
  firstComment: boolean;
}

export const PLATFORM_LIMITS: Record<Platform, PlatformLimits> = {
  // Generous on length, and the only one of these where a body link is both
  // clickable and unpenalised.
  facebook: { caption: 63206, hashtags: 30, altText: 1000, linkInBody: true, firstComment: true },
  // A link in an Instagram caption is not clickable, so copy that puts one
  // there is copy that wastes the line.
  instagram: { caption: 2200, hashtags: 30, altText: 1000, linkInBody: false, firstComment: true },
  tiktok: { caption: 2200, hashtags: 30, altText: null, linkInBody: false, firstComment: true },
  linkedin: { caption: 3000, hashtags: 30, altText: 300, linkInBody: true, firstComment: true },
  // The caption here is the description. YouTube has no first comment in the
  // sense the others do — a pinned comment is a separate action.
  youtube: { caption: 5000, hashtags: 15, altText: null, linkInBody: true, firstComment: false },
};

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

export interface CopyDraft {
  caption?: string | null;
  hashtags?: readonly string[] | null;
  alt_text?: string | null;
  link_url?: string | null;
  first_comment?: string | null;
}

/**
 * Everything wrong with this copy for this platform, in the order a person
 * would fix it. Empty means it can go out.
 *
 * A list rather than the first problem, for the same reason validateEdl
 * returns one: a writer who gets told about the caption, fixes it, and is then
 * told about the hashtags has been made to do two rounds of one job.
 */
export function checkCopy(platform: Platform, copy: CopyDraft): string[] {
  const limits = PLATFORM_LIMITS[platform];
  const problems: string[] = [];
  const name = platformName(platform);

  const caption = copy.caption?.trim() ?? "";
  if (caption.length > limits.caption) {
    problems.push(
      `The caption is ${caption.length} characters. ${name} takes ${limits.caption.toLocaleString("en-GB")}.`,
    );
  }

  const hashtags = copy.hashtags ?? [];
  if (hashtags.length > limits.hashtags) {
    problems.push(`There are ${hashtags.length} hashtags. ${name} takes ${limits.hashtags}.`);
  }
  for (const tag of hashtags) {
    if (!/^#?[\p{L}\p{N}_]+$/u.test(tag)) {
      problems.push(`"${tag}" is not a hashtag ${name} will read: letters, numbers and underscores only.`);
    }
  }

  const alt = copy.alt_text?.trim() ?? "";
  if (alt) {
    if (limits.altText === null) {
      problems.push(`${name} has no alt text, so this would not go anywhere.`);
    } else if (alt.length > limits.altText) {
      problems.push(`The alt text is ${alt.length} characters. ${name} takes ${limits.altText}.`);
    }
  }

  if (copy.link_url?.trim()) {
    if (!isHttpUrl(copy.link_url.trim())) {
      problems.push("The link has to be a http or https address.");
    } else if (!limits.linkInBody) {
      problems.push(`A link in a ${name} caption is not clickable. Put it in the first comment or the bio.`);
    }
  }

  const firstComment = copy.first_comment?.trim() ?? "";
  if (firstComment) {
    if (!limits.firstComment) {
      problems.push(`${name} has no first comment.`);
    } else if (firstComment.length > limits.caption) {
      problems.push(
        `The first comment is ${firstComment.length} characters. ${name} takes ${limits.caption.toLocaleString("en-GB")}.`,
      );
    }
  }

  return problems;
}

/** Characters left in the caption, which is what a form wants to show. */
export function captionRemaining(platform: Platform, caption: string): number {
  return PLATFORM_LIMITS[platform].caption - caption.length;
}

export function platformName(platform: Platform): string {
  return platform === "tiktok"
    ? "TikTok"
    : platform === "youtube"
      ? "YouTube"
      : platform === "linkedin"
        ? "LinkedIn"
        : platform.charAt(0).toUpperCase() + platform.slice(1);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
