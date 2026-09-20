/**
 * Meta's call-to-action buttons.
 *
 * The CTA on a Meta ad is a button chosen from a fixed list, not a line
 * somebody writes. This is the whole list we use; each campaign template
 * narrows it to the ones its destination can actually serve.
 *
 * That narrowing is the point. SEND_MESSAGE on an ad pointing at a landing
 * page is not a worse choice, it is an invalid one — Meta needs a message
 * destination to attach the button to. Keeping one list and letting templates
 * subset it means the invalid pairing cannot be expressed.
 *
 * Kept in step with META_CTAS in src/lib/metaCta.ts, which renders the labels.
 * Separate packages, so the list exists twice on purpose.
 */
export const META_CTAS = [
  "APPLY_NOW",
  "BOOK_NOW",
  "CONTACT_US",
  "DOWNLOAD",
  "GET_OFFER",
  "GET_QUOTE",
  "LEARN_MORE",
  "SEND_MESSAGE",
  "SHOP_NOW",
  "SIGN_UP",
  "SUBSCRIBE",
] as const;

export type MetaCta = (typeof META_CTAS)[number];

export function isMetaCta(value: unknown): value is MetaCta {
  return typeof value === "string" && (META_CTAS as readonly string[]).includes(value);
}

/**
 * The four that suit a hiring ad pointing at an apply URL.
 *
 * Recruitment had its own copy of the list before this module existed. It is
 * a subset now rather than a separate list, so a value added here cannot
 * silently become valid for a hiring ad — the subset has to name it.
 */
export const RECRUITMENT_CTAS = ["APPLY_NOW", "LEARN_MORE", "SIGN_UP", "CONTACT_US"] as const;
