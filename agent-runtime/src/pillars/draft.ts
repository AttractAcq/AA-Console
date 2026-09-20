/**
 * A proposed set of content pillars.
 *
 * Proposed once, then owned by a person. That is the whole point: the
 * ideation agent already produces pillar-shaped labels on every run, and
 * because nothing keeps them, it produces a different set each time —
 * "Continuity and certainty" one run, "Continuity and Certainty" the next.
 * A set that regenerates is the drift, not the fix.
 *
 * So this validates a whole set rather than a pillar at a time. The rules
 * that matter are set-level: how many there are, whether their shares add
 * up, and whether any two are the same pillar twice.
 */

/** Three is the floor, six the cap. Below three is not a strategy; above six is a list of labels. */
export const MIN_PILLARS = 3;
export const MAX_PILLARS = 6;

export interface PillarDraft {
  name: string;
  premise: string;
  belongs: string;
  does_not_belong: string;
  target_share: number;
}

export interface Pillar extends PillarDraft {
  slug: string;
}

/**
 * A url-safe, stable key for a pillar.
 *
 * Stored so a rename does not orphan the ideas filed under it. Derived from
 * the name once, at proposal time, and never recomputed afterwards.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function asShare(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.round(n), 100);
}

export function normalisePillars(raw: unknown): Pillar[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Pillar[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const name = str(e.name);
    if (!name) continue;
    let slug = slugify(name);
    if (!slug) continue;
    // Two pillars whose names differ only in punctuation would collide. The
    // set-level check rejects that rather than silently keeping one, so the
    // duplicate is kept here for the check to see.
    if (seen.has(slug)) slug = `${slug}-2`;
    seen.add(slug);
    out.push({
      slug,
      name,
      premise: str(e.premise),
      belongs: str(e.belongs),
      does_not_belong: str(e.does_not_belong),
      target_share: asShare(e.target_share),
    });
  }
  return out;
}

/**
 * Why this set cannot be saved, or null if it can.
 *
 * Correctness only. How well a pillar is written is taste and belongs in the
 * prompt; what is checked here is what would make the set unusable — the
 * wrong number of them, a boundary nobody stated, shares that do not add up,
 * or the same pillar proposed twice.
 */
export function pillarSetProblem(pillars: readonly Pillar[]): string | null {
  if (pillars.length < MIN_PILLARS) {
    return `A brand needs at least ${MIN_PILLARS} content pillars. This set has ${pillars.length}.`;
  }
  if (pillars.length > MAX_PILLARS) {
    return `A brand may have at most ${MAX_PILLARS} content pillars. This set has ${pillars.length}.`;
  }

  const slugs = new Set<string>();
  for (const p of pillars) {
    if (!p.premise) return `"${p.name}" has no premise, so nothing says what it argues.`;
    if (!p.belongs) return `"${p.name}" does not say what belongs in it.`;
    // The half people skip. A pillar defined only by what belongs in it
    // absorbs anything, and the model is the one doing the sorting.
    if (!p.does_not_belong) {
      return `"${p.name}" does not say what stays out of it. Without that boundary a pillar absorbs everything.`;
    }
    if (slugs.has(p.slug.replace(/-2$/, ""))) {
      return `"${p.name}" is the same pillar as one already in the set.`;
    }
    slugs.add(p.slug);
  }

  const total = pillars.reduce((sum, p) => sum + p.target_share, 0);
  // Not exactly 100: rounding five pillars into whole percentages cannot
  // always land on it, and refusing 99 would be refusing arithmetic.
  if (total < 95 || total > 105) {
    return `The target shares add up to ${total}%, not 100%. A calendar cannot be split that way.`;
  }

  return null;
}
