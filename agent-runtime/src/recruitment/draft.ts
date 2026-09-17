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

// Meta static: the headline is a line, the primary text is a short paragraph.
// These are the shapes the ad has room for, not stylistic preferences.
const LIMITS = {
  title: 120,
  hook: 80,
  script: 900,
  call_to_action: 30,
  visual_direction: 600,
  premise: 400,
} as const;

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
  if (!visual) return "The draft says nothing about what the image should show.";

  if (script.length < MIN_SCRIPT) {
    return "The primary text is too thin to be an ad. Say what the role actually involves.";
  }
  if (visual.length < MIN_VISUAL) {
    return "The visual direction is too thin to brief an image from.";
  }

  for (const field of DRAFT_FIELDS) {
    const value = text(draft[field]);
    const limit = LIMITS[field];
    if (value.length > limit) {
      return `The ${field.replace(/_/g, " ")} is ${value.length} characters; Meta static allows ${limit}.`;
    }
  }

  // The copy fields only. Visual direction may legitimately describe a screen
  // with a feed on it, and the premise is internal framing.
  for (const field of ["title", "hook", "script", "call_to_action"] as const) {
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
    title: text(draft.title),
    hook: text(draft.hook),
    script: text(draft.script),
    call_to_action: text(draft.call_to_action),
    visual_direction: text(draft.visual_direction),
    premise: text(draft.premise),
  };
}
