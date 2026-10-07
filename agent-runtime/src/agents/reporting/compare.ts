/**
 * The period before this one.
 *
 * The commentary agent was told to "lead with the thing that changed" and,
 * two paragraphs later, never to invent "a comparison to a previous period
 * you were not given" — and it was never given one. Both instructions were
 * right and together they were impossible, so every write-up was a snapshot
 * with no trend in it, which is the one thing an operator about to talk to a
 * client actually needs.
 *
 * Every delta here is computed in code for the same reason every total is:
 * a number the model derived is a number nobody checked.
 *
 * WHAT WILL NOT BE COMPARED, AND WHY
 *
 * Cumulative post figures. metrics_period_summary takes the latest snapshot
 * per post, and a snapshot is lifetime-to-date. The prior window's snapshot
 * for a post that existed in both windows is a subset of this window's, so
 * subtracting them would produce a plausible, wrong "growth" number for
 * every post — and a reassuring one, because it is always positive.
 *
 * Windows with unequal coverage. Thirty days of data against three days of
 * data is not a trend, however the arithmetic comes out. The ingest
 * backfills a trailing window and a newly connected integration has days
 * missing, so this is the normal case rather than the edge one.
 *
 * Movements off a tiny base. One click becoming three is +200%, and an
 * operator who repeats that to a client has been misled by this file.
 */

import type { PeriodSummary } from "./index.js";

/** Below this, a percentage is arithmetic rather than information. */
export const MIN_BASE_FOR_PERCENT = 20;

/**
 * How different two windows' coverage may be before a comparison is refused,
 * as a fraction of the longer one. A fifth is enough to absorb one missing
 * day in a week without excusing a window that is mostly absent.
 */
export const MAX_COVERAGE_GAP = 0.2;

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

export function comparePaid(now: PeriodSummary, before: PeriodSummary): Comparison {
  const refusal = coverageRefusal("Paid", now.paid.days_covered, before.paid.days_covered);
  if (refusal) return { deltas: [], refusal };
  return {
    refusal: null,
    deltas: [
      delta("Spend", now.paid.spend, before.paid.spend),
      delta("Impressions", now.paid.impressions, before.paid.impressions),
      delta("Clicks", now.paid.clicks, before.paid.clicks),
      delta("Conversions", now.paid.conversions, before.paid.conversions),
    ],
  };
}

export function compareOrganicAccount(now: PeriodSummary, before: PeriodSummary): Comparison {
  const refusal = coverageRefusal(
    "Organic account",
    now.organic_account.days_covered,
    before.organic_account.days_covered,
  );
  if (refusal) return { deltas: [], refusal };
  return {
    refusal: null,
    deltas: [
      delta("Impressions", now.organic_account.impressions, before.organic_account.impressions),
      // Both sides are "the best single day", which is the only reach figure
      // that compares. A sum would double-count anybody who saw the account
      // twice, in each window independently.
      delta("Best day for reach", now.organic_account.best_day_reach, before.organic_account.best_day_reach),
      delta("Interactions", now.organic_account.engagements, before.organic_account.engagements),
    ],
  };
}

function renderDelta(d: Delta, currency?: string | null): string {
  const fmt = (n: number) =>
    currency !== undefined && currency !== null ? `${currency} ${n.toFixed(2)}` : String(n);
  const direction = d.change > 0 ? "up" : d.change < 0 ? "down" : "flat";
  const pct = d.percent === null ? "" : ` (${d.percent > 0 ? "+" : ""}${d.percent}%)`;
  const because = d.note ? `, no percentage: ${d.note}` : "";
  return `- ${d.label}: ${fmt(d.now)} now against ${fmt(d.before)} before — ${direction} ${fmt(
    Math.abs(d.change),
  )}${pct}${because}`;
}

/**
 * The comparison, as prose for the prompt. Nothing here is a judgement about
 * whether a movement matters: that is the model's job, and the figures it
 * needs to make it are all present.
 */
export function formatComparison(now: PeriodSummary, before: PeriodSummary): string {
  const lines: string[] = [
    "",
    "=== THE PERIOD BEFORE THIS ONE ===",
    `Comparing ${now.window.since} to ${now.window.until} against ${before.window.since} to ${before.window.until}.`,
    "Every change below is already calculated. Use these numbers as given and do not work out any others.",
  ];

  const paid = comparePaid(now, before);
  lines.push("", "PAID, CHANGE");
  if (paid.refusal) lines.push(`- ${paid.refusal}`);
  else {
    lines.push(renderDelta(paid.deltas[0]!, now.paid.currency));
    for (const d of paid.deltas.slice(1)) lines.push(renderDelta(d));
  }

  const organic = compareOrganicAccount(now, before);
  lines.push("", "ORGANIC ACCOUNT, CHANGE");
  if (organic.refusal) lines.push(`- ${organic.refusal}`);
  else for (const d of organic.deltas) lines.push(renderDelta(d));

  lines.push(
    "",
    "ORGANIC POSTS, CHANGE: not available, and not an omission.",
    "Post figures are lifetime-to-date snapshots, so the earlier snapshot of a post that existed in both periods is contained in the later one. Subtracting them would produce a confident, wrong growth figure — and always a positive one. Do not compare individual posts across the two periods.",
  );

  return lines.join("\n");
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
