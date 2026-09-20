/**
 * Content pillars — the three to six things a brand posts about.
 *
 * Kept in step with agent-runtime/src/pillars/draft.ts, which validates what
 * the generator returns. Separate packages, so the rules exist twice.
 *
 * Organic only, by decision. A paid ad argues something too, but a pillar and
 * a campaign template on one screen is one dimension too many.
 */

export const MIN_PILLARS = 3;
export const MAX_PILLARS = 6;

export interface ContentPillar {
  id: string;
  slug: string;
  name: string;
  premise: string;
  belongs: string;
  does_not_belong: string;
  target_share: number;
  active: boolean;
}

/** A pillar as the generator proposes it, before it has an id. */
export type ProposedPillar = Omit<ContentPillar, "id" | "active">;

export function totalShare(pillars: readonly { target_share: number }[]): number {
  return pillars.reduce((sum, p) => sum + (Number(p.target_share) || 0), 0);
}

/**
 * Why this set cannot be saved, or null if it can.
 *
 * Mirrors pillarSetProblem in the runtime. The 95–105 window is not
 * sloppiness: rounding five pillars into whole percentages cannot always
 * land on 100, and refusing 99 would be refusing arithmetic.
 */
export function pillarSetProblem(pillars: readonly ContentPillar[]): string | null {
  const active = pillars.filter((p) => p.active);
  if (active.length < MIN_PILLARS) {
    return `A brand needs at least ${MIN_PILLARS} active pillars. This has ${active.length}.`;
  }
  if (active.length > MAX_PILLARS) {
    return `A brand may have at most ${MAX_PILLARS} active pillars. This has ${active.length}.`;
  }
  for (const p of active) {
    if (!p.name.trim()) return "A pillar needs a name.";
    if (!p.premise.trim()) return `"${p.name}" has no premise, so nothing says what it argues.`;
    if (!p.belongs.trim()) return `"${p.name}" does not say what belongs in it.`;
    if (!p.does_not_belong.trim()) {
      return `"${p.name}" does not say what stays out of it. Without that boundary a pillar absorbs everything.`;
    }
  }
  const total = totalShare(active);
  if (total < 95 || total > 105) {
    return `The target shares add up to ${total}%, not 100%.`;
  }
  return null;
}

/** How far off a balanced calendar this set is, for a hint under the table. */
export function shareHint(pillars: readonly ContentPillar[]): string {
  const total = totalShare(pillars.filter((p) => p.active));
  if (total === 100) return "Shares total 100%.";
  return `Shares total ${total}% — ${total > 100 ? "over" : "under"} by ${Math.abs(100 - total)}.`;
}
