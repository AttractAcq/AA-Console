import { describe, expect, it } from "vitest";

import {
  MAX_COVERAGE_GAP,
  MIN_BASE_FOR_PERCENT,
  comparePaid,
  compareOrganicAccount,
  coverageRefusal,
  delta,
  formatComparison,
  priorWindow,
} from "./compare.js";
import type { PeriodSummary } from "./index.js";

const summary = (over: Partial<PeriodSummary> = {}): PeriodSummary => ({
  window: { since: "2026-09-01", until: "2026-09-30" },
  paid: { spend: 1000, impressions: 50000, clicks: 400, conversions: 40, days_covered: 30, currency: "ZAR" },
  paid_campaigns: [],
  organic_account: { impressions: 20000, best_day_reach: 3000, engagements: 900, days_covered: 30 },
  organic_posts: [],
  unmapped_rows: 0,
  total_rows: 100,
  ...over,
});

describe("the window before this one", () => {
  it("is the same length, ending the day before", () => {
    expect(priorWindow("2026-09-01", "2026-09-30")).toEqual({
      since: "2026-08-02",
      until: "2026-08-31",
    });
  });

  it("counts both ends, as the summary function does", () => {
    // A seven-day window is since..until inclusive, so the one before it is
    // seven days too — not six, and not eight.
    expect(priorWindow("2026-09-08", "2026-09-14")).toEqual({
      since: "2026-09-01",
      until: "2026-09-07",
    });
  });

  it("handles a single day", () => {
    expect(priorWindow("2026-09-10", "2026-09-10")).toEqual({
      since: "2026-09-09",
      until: "2026-09-09",
    });
  });

  it("crosses a month and a year, and takes its length from the window", () => {
    // 31 days of January, so 31 days of December — not the 30 a month-shaped
    // guess would give.
    expect(priorWindow("2027-01-01", "2027-01-31")).toEqual({
      since: "2026-12-01",
      until: "2026-12-31",
    });
    // And February, where a month-shaped guess is wrong the other way.
    expect(priorWindow("2027-03-01", "2027-03-31")).toEqual({
      since: "2027-01-29",
      until: "2027-02-28",
    });
  });
});

describe("one change", () => {
  it("gives the absolute move and the percentage", () => {
    expect(delta("Clicks", 150, 100)).toMatchObject({ change: 50, percent: 50 });
    expect(delta("Clicks", 50, 100)).toMatchObject({ change: -50, percent: -50 });
  });

  it("refuses a percentage off nothing, rather than calling it infinite", () => {
    const d = delta("Conversions", 5, 0);
    expect(d.percent).toBeNull();
    expect(d.note).toMatch(/none in the period before/);
  });

  it("says when there was nothing in either period", () => {
    expect(delta("Conversions", 0, 0).note).toMatch(/none in either period/);
  });

  it("refuses a percentage off a base too small to carry one", () => {
    // One click becoming three is +200%, and an operator who repeats that to
    // a client has been misled.
    const d = delta("Clicks", 3, 1);
    expect(d.change).toBe(2);
    expect(d.percent).toBeNull();
    expect(d.note).toMatch(/too small a base/);

    // And the threshold itself is honoured on both sides.
    expect(delta("Clicks", 30, MIN_BASE_FOR_PERCENT).percent).not.toBeNull();
    expect(delta("Clicks", 30, MIN_BASE_FOR_PERCENT - 1).percent).toBeNull();
  });

  it("reports a flat figure as flat, not as a change of nothing", () => {
    expect(delta("Spend", 100, 100)).toMatchObject({ change: 0, percent: 0 });
  });
});

describe("whether two windows can honestly be compared", () => {
  it("refuses when this period has no data", () => {
    expect(coverageRefusal("Paid", 0, 30)).toMatch(/nothing to compare/);
  });

  it("says a first window with data is not a rise from zero", () => {
    // The difference matters: one is a trend, the other is the ingest
    // having started.
    expect(coverageRefusal("Paid", 30, 0)).toMatch(/first window with data, not a rise from zero/);
  });

  it("refuses two windows whose coverage is too uneven", () => {
    // The ingest backfills a trailing window and a newly connected
    // integration has days missing, so this is the normal case.
    expect(coverageRefusal("Paid", 30, 3)).toMatch(/too uneven to compare/);
    expect(coverageRefusal("Paid", 30, 3)).toContain("30 day(s) now against 3 before");
  });

  it("absorbs one missing day in a week", () => {
    expect(coverageRefusal("Paid", 7, 6)).toBeNull();
    expect(Math.abs(7 - 6) / 7).toBeLessThanOrEqual(MAX_COVERAGE_GAP);
  });

  it("allows an exact match", () => {
    expect(coverageRefusal("Paid", 30, 30)).toBeNull();
  });
});

describe("the comparison the prompt gets", () => {
  it("compares paid and the organic account", () => {
    const text = formatComparison(
      summary(),
      summary({
        window: { since: "2026-08-02", until: "2026-08-31" },
        paid: { spend: 800, impressions: 40000, clicks: 300, conversions: 50, days_covered: 30, currency: "ZAR" },
        organic_account: { impressions: 15000, best_day_reach: 2500, engagements: 1000, days_covered: 30 },
      }),
    );
    expect(text).toContain("Comparing 2026-09-01 to 2026-09-30 against 2026-08-02 to 2026-08-31");
    expect(text).toContain("Spend: ZAR 1000.00 now against ZAR 800.00 before — up ZAR 200.00 (+25%)");
    expect(text).toContain("Clicks: 400 now against 300 before — up 100 (+33.3%)");
    // Down is reported as down, not as a negative rise.
    expect(text).toContain("Conversions: 40 now against 50 before — down 10 (-20%)");
    expect(text).toContain("Interactions: 900 now against 1000 before — down 100 (-10%)");
  });

  it("compares the best day for reach against the best day, never a sum", () => {
    // Reach counts people. A sum would double-count anybody who saw the
    // account twice, in each window independently.
    const text = formatComparison(summary(), summary({ organic_account: { impressions: 15000, best_day_reach: 2000, engagements: 900, days_covered: 30 } }));
    expect(text).toContain("Best day for reach: 3000 now against 2000 before");
  });

  it("refuses to compare individual posts, and says it is not an omission", () => {
    // Post figures are lifetime-to-date, so the earlier snapshot of a post
    // in both periods is contained in the later one. Subtracting them gives
    // a confident, wrong, always-positive growth figure.
    const text = formatComparison(summary(), summary());
    expect(text).toContain("ORGANIC POSTS, CHANGE: not available, and not an omission.");
    expect(text).toContain("lifetime-to-date");
    expect(text).toMatch(/Do not compare individual posts/);
  });

  it("states the refusal instead of leaving the section empty", () => {
    const text = formatComparison(
      summary(),
      summary({ paid: { spend: 0, impressions: 0, clicks: 0, conversions: 0, days_covered: 2, currency: null } }),
    );
    expect(text).toContain("PAID, CHANGE");
    expect(text).toMatch(/too uneven to compare/);
    // And the organic half is unaffected by the paid refusal.
    expect(text).toContain("Impressions: 20000 now against 20000 before");
  });

  it("tells the model the numbers are already worked out", () => {
    // The whole arithmetic-honesty claim: a number the model derived is a
    // number nobody checked.
    const text = formatComparison(summary(), summary());
    expect(text).toMatch(/already calculated. Use these numbers as given and do not work out any others/);
  });

  it("carries the currency on money and not on counts", () => {
    const text = formatComparison(summary(), summary());
    expect(text).toContain("Spend: ZAR 1000.00");
    expect(text).not.toContain("Clicks: ZAR");
  });
});

describe("the two halves refuse independently", () => {
  it("compares organic when paid cannot be compared", () => {
    const paid = comparePaid(summary().paid, {
      spend: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      days_covered: 0,
      currency: null,
    });
    const organic = compareOrganicAccount(summary().organic_account, summary().organic_account);
    expect(paid.refusal).not.toBeNull();
    expect(paid.deltas).toEqual([]);
    expect(organic.refusal).toBeNull();
    expect(organic.deltas).toHaveLength(3);
  });
});
