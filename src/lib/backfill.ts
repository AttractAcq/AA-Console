/**
 * Asking for a window of metrics history.
 *
 * The daily sync pulls the trailing seven days and nothing has ever asked
 * for anything else, so a client connected in October has no September. The
 * Integrations panel has said "you can still run a pull by hand" since it
 * was written; this is the half that makes that true.
 *
 * The window arithmetic is here rather than in the component so it can be
 * tested without a browser, and the length cap is deliberately NOT here: it
 * lives in `max_backfill_days()` and is read from the database. Migration
 * 156 was caused by a rule written down in two places and the two drifting,
 * and a cap the UI believes is 400 while the database enforces 90 is the
 * same mistake with a worse error message.
 */

export type Surface = "paid" | "organic" | "both";

export interface Window {
  since: string;
  until: string;
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const day = 86_400_000;

/** The last N days up to and including yesterday. */
export function trailing(days: number, today = new Date()): Window {
  // Yesterday, not today: today's figures are a few hours old at best and
  // the daily sync re-pulls them anyway, so a backfill that includes today
  // spends a request on a number that is about to change.
  const until = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - day);
  const since = new Date(until.getTime() - (days - 1) * day);
  return { since: iso(since), until: iso(until) };
}

/** A whole calendar month, counted back from this one. 1 = last month. */
export function monthsAgo(n: number, today = new Date()): Window {
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  return { since: iso(first), until: iso(last) };
}

export interface Preset {
  id: string;
  label: string;
  window: (today?: Date) => Window;
}

export const PRESETS: readonly Preset[] = [
  { id: "7d", label: "Last 7 days", window: (t) => trailing(7, t) },
  { id: "30d", label: "Last 30 days", window: (t) => trailing(30, t) },
  { id: "90d", label: "Last 90 days", window: (t) => trailing(90, t) },
  { id: "last-month", label: "Last calendar month", window: (t) => monthsAgo(1, t) },
];

/** Inclusive of both ends, as the database counts it. */
export function windowDays(w: Window): number {
  const since = Date.parse(`${w.since}T00:00:00Z`);
  const until = Date.parse(`${w.until}T00:00:00Z`);
  if (!Number.isFinite(since) || !Number.isFinite(until)) return 0;
  return Math.round((until - since) / day) + 1;
}

/**
 * What is wrong with this window, in the words the database would use, or
 * null if it would accept it. Said here so a person is not made to wait for
 * a round trip to be told the dates are the wrong way round.
 *
 * `maxDays` comes from the database. A null means it has not been read yet,
 * and in that case the length is not checked here at all — better to let the
 * server refuse it than to invent a limit.
 */
export function windowProblem(w: Window, maxDays: number | null, today = new Date()): string | null {
  if (!w.since || !w.until) return "Pick both ends of the window.";
  const days = windowDays(w);
  if (days <= 0) return "That window starts after it ends.";
  const yesterdayOrLater = iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())));
  if (w.until > yesterdayOrLater) return "That window ends in the future.";
  if (maxDays !== null && days > maxDays) {
    return `That is ${days} days. One backfill may ask for at most ${maxDays} — split it into several.`;
  }
  return null;
}

export interface CoverageRow {
  surface: string;
  first_day: string | null;
  last_day: string | null;
  days_with_data: number | null;
  days_missing_inside: number | null;
  last_fetched_at: string | null;
}

/**
 * What is already here, as one sentence.
 *
 * A gap inside the span and a short span mean different things — a failed
 * pull against a young integration — so they are said differently rather
 * than both reported as "some days missing".
 */
export function coverageSentence(row: CoverageRow | undefined, surface: string): string {
  if (!row || !row.first_day || !row.last_day) {
    return `No ${surface} metrics on file. A backfill is the only way to get any.`;
  }
  const gaps = row.days_missing_inside ?? 0;
  const held = `${row.days_with_data ?? 0} day${row.days_with_data === 1 ? "" : "s"} from ${row.first_day} to ${row.last_day}`;
  if (gaps > 0) {
    return `${held}, with ${gaps} day${gaps === 1 ? "" : "s"} missing inside that span — a pull that failed rather than a young account.`;
  }
  return `${held}, with no gaps.`;
}
