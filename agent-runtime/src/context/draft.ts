// Drafting the form everything else reads from.
//
// Business Input is ten fields and the longest form in the console, and it is
// the one a new client stares at blankly. Every downstream agent reads it: the
// offer strategist, the ICP agent, the planner, the page writer, the creative
// concept, the sales agent. Thin context here makes cautious output everywhere,
// and nobody can tell why.
//
// It is also the only form with nothing upstream to draw on. A campaign
// proposal reads the strategy work; this IS the thing the strategy work is
// built from. So the inputs are what the operator knows from the sales call
// and what the business has published about itself — which is why this is the
// one generator allowed to search the web.
//
// That makes the invention risk higher, not lower. A model researching a real
// company will find a competitor's testimonial and attribute it, or read a
// revenue figure off a directory listing. The checks below are stricter than
// anywhere else for exactly that reason.

export interface ContextDraft {
  business_overview: string;
  ideal_customer: string;
  main_offer: string;
  competitors: string;
  brand_voice: string;
  proof_testimonials: string;
  current_marketing: string;
  sales_process: string;
  current_revenue: string;
  target_revenue: string;
}

export const CONTEXT_FIELDS = [
  "business_overview",
  "ideal_customer",
  "main_offer",
  "competitors",
  "brand_voice",
  "proof_testimonials",
  "current_marketing",
  "sales_process",
  "current_revenue",
  "target_revenue",
] as const;

/** The four the form marks required, because every agent reads them. */
const REQUIRED_FIELDS = ["business_overview", "ideal_customer", "main_offer", "competitors"] as const;

const MIN_REQUIRED = 60;

/**
 * A sanity bound, not a brevity rule.
 *
 * The first version was 3000, chosen without looking at the data. Attract
 * Acquisition's own business_overview is 2954 characters — so the cap
 * forbade improving the largest real record in the system, and the first
 * production run was rejected after doing all its searching.
 *
 * The job of this number is to stop runaway output, so it sits well clear of
 * anything real rather than just above it.
 */
const MAX_FIELD = 12000;

const PLACEHOLDER = /\[[^\]]{2,}\]|\{\{[^}]+\}\}/;

/**
 * The two fields a person types or nobody does.
 *
 * Revenue is what a researching model is most likely to guess at — a directory
 * listing, a "fastest-growing" article, a headcount multiplied by a sector
 * average. A wrong figure is not cosmetic: the money model and the economics
 * engine are built on these, and being roughly right is worse than being
 * empty, because empty gets asked about.
 *
 * Dropped rather than validated. There is no version of a researched revenue
 * figure this should keep.
 */
const REVENUE_FIELDS: readonly string[] = ["current_revenue", "target_revenue"];

/** Hedging that means the model is guessing and saying so politely. */
// Both verb forms: "they appear to be" is the plural the first version missed.
const SPECULATION =
  /\b(?:likely|presumably|probably|appears? to be|seems? to be|we can assume|it is assumed|typically would|may well)\b/i;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A field that was thrown away, and why, so the operator is not left guessing. */
export interface DroppedField {
  field: string;
  reason: string;
}

export interface DraftReview {
  draft: ContextDraft;
  dropped: DroppedField[];
  /** Set only when nothing usable survived. */
  problem: string | null;
}

/** Why this single field cannot be shown, or null. */
function fieldProblem(field: string, value: string): string | null {
  if (!value) return null;
  if (value.length > MAX_FIELD) {
    return `${value.length} characters, over the ${MAX_FIELD} limit`;
  }
  if (PLACEHOLDER.test(value)) return "contained a placeholder";
  if (SPECULATION.test(value)) {
    return "was hedging rather than reporting, and a hedged sentence reads as fact once an agent quotes it";
  }
  return null;
}

/**
 * Review a draft field by field.
 *
 * The first version rejected the WHOLE draft over one bad field, and a
 * researching run costs real money and several minutes. Two production runs
 * were thrown away that way: one for a length cap set below real data, one
 * for a hedged competitors line, both after all the searching was done.
 *
 * So a bad field is blanked and named instead. Eight good fields and one
 * empty one the operator fills is a far better outcome than nothing, and the
 * empty one carries its reason.
 *
 * Only a draft with none of the four required fields left is refused outright
 * — at that point there is nothing worth putting on screen.
 */
export function reviewContextDraft(raw: Record<string, unknown>): DraftReview {
  const draft = normaliseContextDraft(raw);
  const dropped: DroppedField[] = [];

  for (const field of CONTEXT_FIELDS) {
    const value = draft[field];
    const reason = fieldProblem(field, value);
    if (reason) {
      draft[field] = "";
      dropped.push({ field, reason });
    }
  }

  const requiredLeft = REQUIRED_FIELDS.filter((f) => draft[f].trim().length >= MIN_REQUIRED);
  if (requiredLeft.length === 0) {
    return {
      draft,
      dropped,
      problem:
        "Nothing usable came back — none of the four fields every agent reads survived. Try again, or write them yourself.",
    };
  }

  return { draft, dropped, problem: null };
}

/**
 * The draft, with the two money fields dropped.
 *
 * Deliberately not validated and then kept — removed outright. Nothing a
 * researching model finds about a private company's revenue is reliable, and
 * these two figures feed the money model and the economics engine. A person
 * types them or they stay empty.
 */
export function normaliseContextDraft(draft: Record<string, unknown>): ContextDraft {
  const out = {} as ContextDraft;
  for (const field of CONTEXT_FIELDS) {
    out[field] = REVENUE_FIELDS.includes(field) ? "" : text(draft[field]);
  }
  return out;
}
