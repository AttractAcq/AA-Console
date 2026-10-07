/**
 * Period-over-period arithmetic — the browser's mirror.
 *
 * Do not edit below the marker. The source of truth is
 * agent-runtime/src/agents/reporting/compare-shared.ts; run
 * `npm run sync:metrics-compare` to bring this file back into line, and
 * metricsCompare.mirror.test.ts will fail until you do.
 *
 * It exists so the reporting panels and the commentary agent cannot disagree
 * about a change, for the same reason metrics_period_summary exists so they
 * cannot disagree about a total.
 */

// ---- shared region: byte-identical with the mirror; a test enforces it ----

/** Below this, a percentage is arithmetic rather than information. */
export const MIN_BASE_FOR_PERCENT = 20;

/**
 * How different two windows' coverage may be before a comparison is refused,
 * as a fraction of the longer one. A fifth is enough to absorb one missing
 * day in a week without excusing a window that is mostly absent.
 */
export const MAX_COVERAGE_GAP = 0.2;

/** Just the paid figures a comparison needs. */
export interface PaidTotals {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  days_covered: number;
  currency: string | null;
}

/** Just the organic account figures a comparison needs. */
export interface AccountTotals {
  /** Null when no day carried one. Not comparable, and not a zero. */
  impressions: number | null;
  best_day_reach: number;
  engagements: number;
  days_covered: number;
}

export interface Delta {
  label: string;
  now: number;
  before: number;
  /** Absolute change. Always available. */
  change: number;
  /** Percent change, or null when the base is too small or zero to carry one. */
  percent: number | null;
  /** Why there is no percent, when there is none. */
  note?: string;
}

const round = (n: number): number => Math.round(n * 10) / 10;

export function delta(label: string, now: number, before: number): Delta {
  const change = round(now - before);
  if (before === 0) {
    return {
      label,
      now,
      before,
      change,
      percent: null,
      note: now === 0 ? "none in either period" : "none in the period before",
    };
  }
  if (Math.abs(before) < MIN_BASE_FOR_PERCENT) {
    return {
      label,
      now,
      before,
      change,
      percent: null,
      note: `too small a base (${before}) for a percentage to mean anything`,
    };
  }
  return { label, now, before, change, percent: round(((now - before) / before) * 100) };
}

export interface Comparison {
  /** Present only when the two windows can honestly be compared. */
  deltas: Delta[];
  /** The one sentence explaining a refusal, or null when there is nothing to explain. */
  refusal: string | null;
}

/**
 * Whether two windows' coverage is close enough to compare, and if not, why.
 * Separate from the arithmetic so the refusal can be stated rather than
 * inferred from an empty list.
 */
export function coverageRefusal(
  what: string,
  nowDays: number,
  beforeDays: number,
): string | null {
  if (nowDays === 0) return `No ${what} data in this period, so there is nothing to compare.`;
  if (beforeDays === 0) {
    return `No ${what} data in the period before this one, so no comparison is possible — this is the first window with data, not a rise from zero.`;
  }
  const longer = Math.max(nowDays, beforeDays);
  if (Math.abs(nowDays - beforeDays) / longer > MAX_COVERAGE_GAP) {
    return `${what} covers ${nowDays} day(s) now against ${beforeDays} before, which is too uneven to compare. Say so rather than reporting the difference.`;
  }
  return null;
}

export function comparePaid(now: PaidTotals, before: PaidTotals): Comparison {
  const refusal = coverageRefusal("Paid", now.days_covered, before.days_covered);
  if (refusal) return { deltas: [], refusal };
  return {
    refusal: null,
    deltas: [
      delta("Spend", now.spend, before.spend),
      delta("Impressions", now.impressions, before.impressions),
      delta("Clicks", now.clicks, before.clicks),
      delta("Conversions", now.conversions, before.conversions),
    ],
  };
}

export function compareOrganicAccount(now: AccountTotals, before: AccountTotals): Comparison {
  const refusal = coverageRefusal("Organic account", now.days_covered, before.days_covered);
  if (refusal) return { deltas: [], refusal };
  return {
    refusal: null,
    deltas: [
      // Impressions only when both sides have one. Treating a null as 0
      // would report a fall to nothing, or a rise from it, for a figure
      // the account endpoint simply does not return.
      ...(now.impressions !== null && before.impressions !== null
        ? [delta("Impressions", now.impressions, before.impressions)]
        : []),
      // Both sides are "the best single day", which is the only reach figure
      // that compares. A sum would double-count anybody who saw the account
      // twice, in each window independently.
      delta("Best day for reach", now.best_day_reach, before.best_day_reach),
      delta("Interactions", now.engagements, before.engagements),
    ],
  };
}

/** The window immediately before this one, of the same length. */
export function priorWindow(since: string, until: string): { since: string; until: string } {
  const start = new Date(`${since}T00:00:00Z`);
  const end = new Date(`${until}T00:00:00Z`);
  // Inclusive of both ends, which is how metrics_period_summary reads them.
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const priorEnd = new Date(start.getTime() - 86_400_000);
  const priorStart = new Date(priorEnd.getTime() - (days - 1) * 86_400_000);
  return {
    since: priorStart.toISOString().slice(0, 10),
    until: priorEnd.toISOString().slice(0, 10),
  };
}
