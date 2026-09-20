/**
 * Where a scheduled post goes.
 *
 * Distinct from channel, which is organic or paid and says how a post is
 * distributed rather than where it lands. A post can be planned before its
 * feed is decided, so this is optional everywhere.
 *
 * Kept in step with the post_platform enum in migration 99.
 */
export const POST_PLATFORMS = [
  { value: "instagram", label: "Instagram" },
  { value: "facebook", label: "Facebook" },
  { value: "tiktok", label: "TikTok" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "youtube", label: "YouTube" },
] as const;

export type PostPlatform = (typeof POST_PLATFORMS)[number]["value"];

export function platformLabel(value: string | null | undefined): string {
  const raw = (value ?? "").trim();
  if (!raw) return "—";
  return POST_PLATFORMS.find((p) => p.value === raw)?.label ?? raw;
}

/**
 * The platform a brief was written for, if its channel intent names one.
 *
 * channel_intent is free text — "Instagram Reel", "TikTok, 9:16" — so this
 * matches rather than parses, and returns nothing when it cannot be sure.
 * A wrong pre-selection is worse than none: it is a decision nobody made
 * that looks like one somebody did.
 */
export function platformFromIntent(intent: string | null | undefined): PostPlatform | null {
  const text = (intent ?? "").toLowerCase();
  if (!text.trim()) return null;
  const hits = POST_PLATFORMS.filter((p) => text.includes(p.value));
  return hits.length === 1 ? hits[0]!.value : null;
}
