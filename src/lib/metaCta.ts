/**
 * Meta's call-to-action buttons, with the labels a person reads.
 *
 * Kept in step with META_CTAS in agent-runtime/src/meta/cta.ts, which validates
 * what a generator returns. Separate packages, so the list exists twice.
 *
 * Recruitment's four live in lib/recruitment.ts as a subset. A form offering
 * the whole list for a hiring ad would be offering SEND_MESSAGE on an ad that
 * points at an apply URL, which Meta rejects.
 */
export const META_CTAS = [
  { value: "APPLY_NOW", label: "Apply now" },
  { value: "BOOK_NOW", label: "Book now" },
  { value: "CONTACT_US", label: "Contact us" },
  { value: "DOWNLOAD", label: "Download" },
  { value: "GET_OFFER", label: "Get offer" },
  { value: "GET_QUOTE", label: "Get quote" },
  { value: "LEARN_MORE", label: "Learn more" },
  { value: "SEND_MESSAGE", label: "Send message" },
  { value: "SHOP_NOW", label: "Shop now" },
  { value: "SIGN_UP", label: "Sign up" },
  { value: "SUBSCRIBE", label: "Subscribe" },
] as const;

export type MetaCtaValue = (typeof META_CTAS)[number]["value"];

/**
 * The button's label, for a screen.
 *
 * Falls back to whatever is stored, because briefs written before the CTA was
 * a fixed value hold prose like "Apply now" and must keep rendering.
 */
export function metaCtaLabel(value: string | null | undefined): string {
  const raw = (value ?? "").trim();
  return META_CTAS.find((c) => c.value === raw)?.label ?? raw;
}
