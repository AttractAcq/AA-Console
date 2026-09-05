import { describe, expect, it } from "vitest";
import { formatSummary, type PeriodSummary } from "./index.js";

// The aggregation itself is done by metrics_period_summary() in the
// database and verified there; these tests cover the layer that turns it
// into prose, and the claims that prose is allowed to make.
const base: PeriodSummary = {
  window: { since: "2026-09-01", until: "2026-09-05" },
  paid: { spend: 150, impressions: 1500, clicks: 15, conversions: 3, days_covered: 2, currency: "ZAR" },
  paid_campaigns: [
    { external_id: "c1", campaign_ref: "HD-C002", target_role: "implants", mapped: true,
      spend: 150, impressions: 1500, clicks: 15, conversions: 3, days_active: 2 },
  ],
  organic_account: { impressions: 2700, best_day_reach: 1100, engagements: 120, days_covered: 2 },
  organic_posts: [
    { external_id: "p1", ref_number: "AA-ORG-016", media_type: "video", mapped: true,
      as_at: "2026-09-03", impressions: 4600, reach: 3400, engagements: 210 },
  ],
  unmapped_rows: 0,
  total_rows: 6,
};

describe("reporting commentary input", () => {
  it("passes the aggregate through without recomputing it", () => {
    const out = formatSummary(base);
    expect(out).toContain("Spend: ZAR 150.00");
    expect(out).toContain("Conversions: 3");
    expect(out).toContain("Impressions across the period: 2700");
  });

  it("labels derived ratios as derived, so they are not read as measured", () => {
    const out = formatSummary(base);
    expect(out).toContain("Cost per click (derived): 10.00");
    expect(out).toContain("Cost per conversion (derived): 50.00");
  });

  it("says so rather than dividing by zero", () => {
    const out = formatSummary({ ...base, paid: { ...base.paid, conversions: 0 } });
    expect(out).toContain("no conversions recorded");
    expect(out).not.toMatch(/Infinity|NaN/);
  });

  it("warns in the prompt that post totals are lifetime, not this period", () => {
    const out = formatSummary(base);
    expect(out).toContain("lifetime-to-date");
    expect(out).toContain("Never add them together");
    expect(out).toContain("as at 2026-09-03");
  });

  it("never presents reach as a period total", () => {
    const out = formatSummary(base);
    expect(out).toContain("Best single day for reach: 1100");
    expect(out).not.toMatch(/reach across the period/i);
  });

  it("names a surface that has no data instead of omitting it", () => {
    const out = formatSummary({
      ...base,
      organic_account: { impressions: 0, best_day_reach: 0, engagements: 0, days_covered: 0 },
      organic_posts: [],
    });
    expect(out).toContain("ORGANIC ACCOUNT: no data ingested");
    expect(out).toContain("ORGANIC POSTS: no data ingested");
  });

  it("surfaces how many days actually had data", () => {
    expect(formatSummary(base)).toContain("Days with data: 2");
  });

  it("flags rows belonging to nothing in the console", () => {
    expect(formatSummary({ ...base, unmapped_rows: 4 })).toContain("could not be matched");
  });

  it("falls back to the platform id when a campaign is not ours", () => {
    const out = formatSummary({
      ...base,
      paid_campaigns: [{ ...base.paid_campaigns[0]!, campaign_ref: null, target_role: null, mapped: false }],
    });
    expect(out).toContain("not in the console, external id c1");
  });
});
