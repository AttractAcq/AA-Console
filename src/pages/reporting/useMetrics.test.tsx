import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("../../lib/supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

import { useMetrics, type PeriodSummary } from "./useMetrics";

const summary = (over: Partial<PeriodSummary> = {}): PeriodSummary => ({
  window: { since: "2026-09-01", until: "2026-09-30" },
  paid: { spend: 1000, impressions: 50000, clicks: 400, conversions: 40, days_covered: 30, currency: "ZAR" },
  paid_campaigns: [],
  organic_account: { impressions: 20000, impression_days: 30, best_day_reach: 3000, engagements: 900, days_covered: 30 },
  organic_posts: [],
  unmapped_rows: 0,
  total_rows: 100,
  ...over,
});

/**
 * Answers by the window asked for, and records what was asked.
 *
 * Keyed on the window rather than on call order: the two reads go out
 * together in a Promise.all, and a mock that counts calls answers the wrong
 * one the moment anything reorders them.
 */
function answers(opts: { prior?: PeriodSummary | null; priorError?: string } = {}) {
  const asked: Array<{ since: string; until: string }> = [];
  const today = new Date().toISOString().slice(0, 10);
  rpc.mockImplementation(async (_name: string, args?: Record<string, string>) => {
    const since = args?.p_since ?? "";
    const until = args?.p_until ?? "";
    asked.push({ since, until });
    const isCurrent = until === today;
    if (!isCurrent && opts.priorError) return { data: null, error: { message: opts.priorError } };
    if (isCurrent) return { data: summary(), error: null };
    return {
      data: opts.prior === undefined ? summary({ paid: { ...summary().paid, clicks: 300 } }) : opts.prior,
      error: null,
    };
  });
  return asked;
}

beforeEach(() => rpc.mockReset());

describe("what the reporting panels are given", () => {
  it("reads the window before this one as well as this one", async () => {
    // Gap 6 for the panels, not just for the write-up: a chart with no
    // trend and a write-up with one disagree by omission.
    const asked = answers();
    const { result } = renderHook(() => useMetrics("client-1", 30));
    await waitFor(() => expect(result.current.trend).not.toBeNull());
    expect(asked).toHaveLength(2);
    const [current, prior] = [...asked].sort((a, b) => a.since.localeCompare(b.since)).reverse();
    // The earlier window ends the day before this one starts.
    expect(prior!.until < current!.since).toBe(true);
  });

  it("computes the change with the same code the commentary uses", async () => {
    answers();
    const { result } = renderHook(() => useMetrics("client-1", 30));
    await waitFor(() => expect(result.current.trend).not.toBeNull());
    const clicks = result.current.trend!.paid.deltas.find((d) => d.label === "Clicks")!;
    expect(clicks).toMatchObject({ now: 400, before: 300, change: 100, percent: 33.3 });
  });

  it("carries the refusal when the two windows cannot be compared", async () => {
    answers({
      prior: summary({ paid: { spend: 0, impressions: 0, clicks: 0, conversions: 0, days_covered: 2, currency: null } }),
    });
    const { result } = renderHook(() => useMetrics("client-1", 30));
    await waitFor(() => expect(result.current.trend).not.toBeNull());
    expect(result.current.trend!.paid.refusal).toMatch(/too uneven to compare/);
    // The organic half is unaffected by the paid refusal.
    expect(result.current.trend!.organic.refusal).toBeNull();
  });

  it("has no trend when there is no earlier data, and still has the totals", async () => {
    answers({ prior: summary({ total_rows: 0 }) });
    const { result } = renderHook(() => useMetrics("client-1", 30));
    await waitFor(() => expect(result.current.summary).not.toBeNull());
    expect(result.current.trend).toBeNull();
    expect(result.current.summary!.paid.clicks).toBe(400);
  });

  it("loses the trend and nothing else when the earlier window cannot be read", async () => {
    // A new feature must not be able to break an old one.
    answers({ priorError: "statement timeout" });
    const { result } = renderHook(() => useMetrics("client-1", 30));
    await waitFor(() => expect(result.current.summary).not.toBeNull());
    expect(result.current.trend).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("reports a failure to read this window", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "permission denied" } });
    const { result } = renderHook(() => useMetrics("client-1", 30));
    await waitFor(() => expect(result.current.error).toBe("permission denied"));
  });
});
