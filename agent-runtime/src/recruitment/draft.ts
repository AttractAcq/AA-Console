// Writing a hiring ad, rather than picking one off a shelf.
//
// The recruitment form shipped with three hard-coded briefs — one per role —
// pre-filled into the fields. They were fine as a demonstration and wrong as a
// product: every editor ad AA ever ran would open with the same sentence, and
// the operator's actual knowledge of the role ("must cut vertical, Durban
// hours, starts January") had nowhere to go except over the top of a stub.
//
// So the operator says what is specific about this role, the model reads what
// AA already knows about itself, and the form is filled with a brief written
// for that opening. The stubs are gone; blank fields and manual typing work
// exactly as before, because the generator writes into the same form rather
// than replacing it.
//
// TWO FIELDS ARE DELIBERATELY NOT GENERATED. The apply URL is where a real
// person sends their real application, and compensation is money AA is
// promising to pay. A model that invents either produces an ad that looks
// finished and is false — the same failure that put a fabricated phone number
// on a practice's advertising. Both stay human-entered.

/**
 * The call-to-action buttons Meta actually offers on a link ad.
 *
 * The generator was writing prose — "Apply with three cutdowns", "Apply to run
 * the calendar". Good copy, and unusable: the CTA on a Meta static is a button
 * chosen from a fixed list, not a line somebody writes. Whoever built the ad
 * would have had to pick a real one and quietly discard the words.
 *
 * Four of Meta's set make sense for a hiring ad pointing at an apply URL.
 * SEND_MESSAGE and the commerce ones need a different destination.
 *
 * Kept in step with META_CTAS in src/lib/recruitment.ts, which renders the
 * labels. Separate packages, so the list exists twice on purpose.
 */
export const META_CTAS = ["APPLY_NOW", "LEARN_MORE", "SIGN_UP", "CONTACT_US"] as const;
export type MetaCta = (typeof META_CTAS)[number];

/** What the model fills in. The rest of the form is the operator's. */
export interface RecruitmentDraft {
  title: string;
  hook: string;
  script: string;
  call_to_action: string;
  visual_direction: string;
  premise: string;
}

export const DRAFT_FIELDS = [
  "title",
  "hook",
  "script",
  "call_to_action",
  "visual_direction",
  "premise",
] as const;

// Only three of these fields are ever seen by Meta, and only those three carry
// a placement limit. The first version of this capped all six at ad-copy
// lengths and rejected real drafts for it: the generator wrote 650 and 850
// character visual directions — good ones — and they were refused for
// exceeding a limit belonging to a placement they are never part of.
//
// The headline is a line and the primary text is a short paragraph because Meta
// has room for that much. That is a fact about the placement.
const META_LIMITS = {
  hook: 80,
  script: 900,
  call_to_action: 30,
} as const;

// Internal, and CLAMPED RATHER THAN REFUSED.
//
// Smoke testing all three roles found three of five generations thrown away
// for overshooting one of these by a handful of characters — a visual
// direction at 2029 against 2000, a premise at 617 against 600. Each rejection
// costs a fresh sixty-second model call, and every one of those drafts was
// good. Refusing a whole hiring ad because an internal note ran seventeen
// characters long is not a standard, it is a tax.
//
// Meta's limits are facts about the world: copy past them breaks a real
// placement, so those still fail. These are our own tidiness, nobody outside
// AA ever sees them, and tidiness is something we can simply do.
const INTERNAL_LIMITS = {
  title: 200,
  visual_direction: 2000,
  premise: 600,
} as const;

/** A last line of defence against something pathological, not a shape. */
const RUNAWAY = 20_000;

/**
 * Trim to the last sentence that fits, rather than cutting mid-word.
 *
 * The visual direction is handed to an image model. A brief ending
 * "...palette restrained and institu" is worse than one sentence shorter.
 */
export function clampToSentence(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const head = value.slice(0, limit);
  const lastStop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (lastStop > limit * 0.5) return head.slice(0, lastStop + 1).trim();
  const lastSpace = head.lastIndexOf(" ");
  return (lastSpace > 0 ? head.slice(0, lastSpace) : head).trim();
}

const MIN_SCRIPT = 80;
const MIN_VISUAL = 30;

/**
 * A bracketed gap the renderer or the reader has to fill.
 *
 * "[day rate]" or "{{role}}" reaching an ad means nobody filled it in and it
 * shipped anyway. Caught here rather than discovered on a live Meta placement.
 */
const PLACEHOLDER = /\[[^\]]{2,}\]|\{\{[^}]+\}\}|<[a-z_ ]{2,}>/i;

/** Anything that looks like a destination or a contact detail. */
const URL_LIKE = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|co\.za|io|net|org)\b/i;
const PHONE_LIKE = /(\+?\d[\d\s().-]{7,}\d)/;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Why this draft cannot be put in front of an applicant, or null.
 *
 * Retryable by design: the model is told what it got wrong and asked again,
 * which is cheaper than an operator deleting a bad draft out of the form by
 * hand and losing what was already right about it.
 */
export function draftProblem(draft: Record<string, unknown>): string | null {
  const title = text(draft.title);
  const hook = text(draft.hook);
  const script = text(draft.script);
  const cta = text(draft.call_to_action);
  const visual = text(draft.visual_direction);

  if (!title) return "The draft has no title.";
  if (!hook) return "The draft has no headline, which is the largest words on the ad.";
  if (!script) return "The draft has no primary text.";
  if (!cta) return "The draft has no call to action.";
  if (!(META_CTAS as readonly string[]).includes(cta)) {
    // A button, not a sentence. Prose here reaches whoever builds the ad and
    // has to be thrown away, because Meta will not render it.
    return `"${cta}" is not a Meta call-to-action button. Choose one of: ${META_CTAS.join(", ")}.`;
  }
  if (!visual) return "The draft says nothing about what the image should show.";

  if (script.length < MIN_SCRIPT) {
    return "The primary text is too thin to be an ad. Say what the role actually involves.";
  }
  if (visual.length < MIN_VISUAL) {
    return "The visual direction is too thin to brief an image from.";
  }

  for (const [field, limit] of Object.entries(META_LIMITS)) {
    const value = text(draft[field]);
    if (value.length > limit) {
      return `The ${field.replace(/_/g, " ")} is ${value.length} characters; Meta static allows ${limit}.`;
    }
  }

  // Internal fields are not checked for length here — normaliseDraft clamps
  // them. Only something pathological is worth losing a whole draft over.
  for (const field of DRAFT_FIELDS) {
    if (text(draft[field]).length > RUNAWAY) {
      return `The ${field.replace(/_/g, " ")} came back implausibly long.`;
    }
  }

  // The copy fields only. Visual direction may legitimately describe a screen
  // with a feed on it, and the premise is internal framing.
  for (const field of ["title", "hook", "script"] as const) {
    const value = text(draft[field]);
    if (PLACEHOLDER.test(value)) {
      return `The ${field.replace(/_/g, " ")} contains a placeholder. Write the real words or leave the element out.`;
    }
    if (URL_LIKE.test(value)) {
      return "The copy contains a link. Candidates leave through the Apply URL field, which a person fills in.";
    }
    if (PHONE_LIKE.test(value)) {
      return "The copy contains a phone number. Nothing here may invent a way to contact AA.";
    }
  }

  return null;
}

/** The draft, with only the fields the form takes and nothing else. */
export function normaliseDraft(draft: Record<string, unknown>): RecruitmentDraft {
  return {
    title: clampToSentence(text(draft.title), INTERNAL_LIMITS.title),
    hook: text(draft.hook),
    script: text(draft.script),
    call_to_action: text(draft.call_to_action),
    visual_direction: clampToSentence(text(draft.visual_direction), INTERNAL_LIMITS.visual_direction),
    premise: clampToSentence(text(draft.premise), INTERNAL_LIMITS.premise),
  };
}
