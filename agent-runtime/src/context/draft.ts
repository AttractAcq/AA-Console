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
const REQUIRED = ["business_overview", "ideal_customer", "main_offer", "competitors"] as const;

const MIN_REQUIRED = 60;
const MAX_FIELD = 3000;

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

/** Why this draft should not be put in front of the operator, or null. */
export function contextDraftProblem(draft: Record<string, unknown>): string | null {
  for (const field of REQUIRED) {
    const value = text(draft[field]);
    if (!value) {
      return `The draft says nothing about ${field.replace(/_/g, " ")}, which every downstream agent reads.`;
    }
    if (value.length < MIN_REQUIRED) {
      return `The ${field.replace(/_/g, " ")} is too thin to be useful. An agent reading it would learn nothing it could act on.`;
    }
  }

  for (const field of CONTEXT_FIELDS) {
    const value = text(draft[field]);
    if (value.length > MAX_FIELD) {
      return `The ${field.replace(/_/g, " ")} is ${value.length} characters; keep it under ${MAX_FIELD}.`;
    }
    if (PLACEHOLDER.test(value)) {
      return `The ${field.replace(/_/g, " ")} contains a placeholder. Write what you actually found or leave it blank.`;
    }
    if (SPECULATION.test(value)) {
      // A hedged guess reads as fact once it is saved and an agent quotes it.
      return `The ${field.replace(/_/g, " ")} is hedging rather than reporting. Write what the sources actually say, or leave the field blank for a person to fill in.`;
    }
  }

  return null;
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
