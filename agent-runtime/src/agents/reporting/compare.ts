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
 * The arithmetic below the marker is mirrored into src/lib/metricsCompare.ts
 * so the reporting panels say the same thing. That is the same argument
 * migration 38 makes about the totals — "a chart saying one thing while the
 * write-up says another is worse than having neither" — applied to the
 * change as well as to the level.
 */

import type { PeriodSummary } from "./index.js";
import {
  compareOrganicAccount,
  comparePaid,
  type Delta,
  priorWindow,
} from "./compare-shared.js";

export * from "./compare-shared.js";

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

  const paid = comparePaid(now.paid, before.paid);
  lines.push("", "PAID, CHANGE");
  if (paid.refusal) lines.push(`- ${paid.refusal}`);
  else {
    lines.push(renderDelta(paid.deltas[0]!, now.paid.currency));
    for (const d of paid.deltas.slice(1)) lines.push(renderDelta(d));
  }

  const organic = compareOrganicAccount(now.organic_account, before.organic_account);
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

// Re-exported for callers that only want the window arithmetic.
export { priorWindow };
