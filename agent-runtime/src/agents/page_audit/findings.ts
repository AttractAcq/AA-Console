// What an audit may report, and which of those things an agent is allowed to
// fix by itself.
//
// The classification is NOT the model's to choose. If it were a field the model
// filled in, then "missing testimonial" marked FIXABLE is one token away from
// an instruction to write a testimonial — and the entire proof system exists to
// stop exactly that. So the model picks a category from a closed list, and the
// classification is derived from the category here, in code, where it cannot be
// argued with.
//
// Adding a category to the wrong list is therefore the one edit in this file
// that can cause fabricated proof to appear on a client's public page.

export type Classification = "FIXABLE" | "NEEDS_PERSON";

/**
 * Things an agent can put right using only what it was already given: words,
 * order, emphasis, structure. None of these require a new fact about the world.
 */
export const FIXABLE_CATEGORIES = [
  "headline",
  "cta_copy",
  "cta_placement",
  "structure",
  "hierarchy",
  "clarity",
  "offer_explanation",
  "objection_handling",
  "duplication",
  "mobile_layout",
  "accessibility",
  "brand_voice",
] as const;

/**
 * Things that need a fact nobody has yet.
 *
 * Every one of these is a claim about the real world — a customer who said
 * something, a number that was measured, a price that was set, a qualification
 * somebody holds. An agent closing one of these is not fixing a page, it is
 * making something up, and the page is what a regulator or a disappointed
 * customer reads back to the client.
 */
export const NEEDS_PERSON_CATEGORIES = [
  "testimonial",
  "case_study",
  "statistic",
  "performance_claim",
  "pricing",
  "guarantee",
  "credential",
  "award",
  "tenure",
  "team_or_location_fact",
  "compliance",
] as const;

export type FixableCategory = (typeof FIXABLE_CATEGORIES)[number];
export type NeedsPersonCategory = (typeof NEEDS_PERSON_CATEGORIES)[number];
export type Category = FixableCategory | NeedsPersonCategory;

export const ALL_CATEGORIES: readonly string[] = [
  ...FIXABLE_CATEGORIES,
  ...NEEDS_PERSON_CATEGORIES,
];

/** More than this and nobody reads the list; the page needs rebuilding, not patching. */
export const MAX_FINDINGS = 25;

export interface Finding {
  category: Category;
  severity: "low" | "medium" | "high";
  title: string;
  explanation: string;
  suggested_direction: string;
  classification: Classification;
}

/**
 * The classification for a category, or null if the category is not one we know.
 *
 * An unrecognised category is dropped rather than defaulted. Defaulting to
 * FIXABLE would let an unknown string become a licence to rewrite; defaulting
 * to NEEDS_PERSON would quietly fill the page's gap list with noise.
 */
export function classificationFor(category: string): Classification | null {
  if ((FIXABLE_CATEGORIES as readonly string[]).includes(category)) return "FIXABLE";
  if ((NEEDS_PERSON_CATEGORIES as readonly string[]).includes(category)) return "NEEDS_PERSON";
  return null;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function severityOf(v: unknown): "low" | "medium" | "high" {
  const s = str(v).toLowerCase();
  return s === "low" || s === "high" ? s : "medium";
}

/**
 * Model output into storable findings.
 *
 * Anything without a known category, a title or an explanation is dropped: a
 * finding nobody can read is not a finding, and a category we do not recognise
 * has no safe classification.
 */
export function normaliseFindings(raw: unknown): Finding[] {
  if (!Array.isArray(raw)) return [];
  const out: Finding[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;

    const category = str(row.category).toLowerCase();
    const classification = classificationFor(category);
    if (!classification) continue;

    const title = str(row.title);
    const explanation = str(row.explanation);
    if (!title || !explanation) continue;

    // One finding per category+title. A model listing the same weak headline
    // three times produces one row, not three.
    const key = `${category}:${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      category: category as Category,
      severity: severityOf(row.severity),
      title,
      explanation,
      suggested_direction: str(row.suggested_direction),
      classification,
    });

    if (out.length >= MAX_FINDINGS) break;
  }

  return out;
}

/** Findings an agent may act on. The only list the reviser is ever given. */
export function fixableOnly(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.classification === "FIXABLE");
}

/** Gaps that need a person. Shown as outstanding work, never as a failure. */
export function needsPersonOnly(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.classification === "NEEDS_PERSON");
}

/**
 * A one-line summary for the job event.
 *
 * Says the needs-person count out loud, because that number is the honest
 * answer to "is this page ready" and is easy to look past in a long list.
 */
export function auditSummary(findings: Finding[]): string {
  const fixable = fixableOnly(findings).length;
  const person = needsPersonOnly(findings).length;
  if (findings.length === 0) return "No findings — the page reads as complete.";
  return `${findings.length} finding${findings.length === 1 ? "" : "s"}: ${fixable} the reviser can fix, ${person} needing a person.`;
}
