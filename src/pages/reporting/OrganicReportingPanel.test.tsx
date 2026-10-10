import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useMetrics = vi.fn();
vi.mock("./useMetrics", async (original) => ({
  ...(await original<typeof import("./useMetrics")>()),
  useMetrics: (...a: unknown[]) => useMetrics(...a),
}));
vi.mock("react-router-dom", () => ({ useParams: () => ({ clientId: "client-1" }) }));

import { OrganicReportingPanel } from "./OrganicReportingPanel";
import type { PeriodSummary } from "./useMetrics";

const summary = (over: Partial<PeriodSummary["organic_account"]> = {}): PeriodSummary => ({
  window: { since: "2026-09-01", until: "2026-09-30" },
  paid: { spend: 0, impressions: 0, clicks: 0, conversions: 0, days_covered: 0, currency: null },
  paid_campaigns: [],
  organic_account: {
    impressions: 20000,
    impression_days: 30,
    best_day_reach: 3000,
    engagements: 900,
    days_covered: 30,
    ...over,
  },
  organic_posts: [],
  unmapped_rows: 0,
  total_rows: 30,
});

beforeEach(() => {
  useMetrics.mockReset();
  useMetrics.mockReturnValue({
    summary: summary(),
    trend: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
});

describe("an account figure the endpoint cannot give", () => {
  it("shows a dash and says why, rather than a zero", async () => {
    // "0 — summed across the period" beside a real reach figure says the
    // account was seen by people and shown to nobody.
    useMetrics.mockReturnValue({
      summary: summary({ impressions: null, impression_days: 0 }),
      trend: null,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    render(<OrganicReportingPanel />);
    expect(await screen.findByText(/Not available per day from the Instagram account endpoint/)).toBeInTheDocument();
    expect(screen.queryByText("Summed across the period")).not.toBeInTheDocument();
    // The figures that do exist are still shown.
    expect(screen.getByText("3,000")).toBeInTheDocument();
  });

  it("shows the number when there is one", async () => {
    render(<OrganicReportingPanel />);
    expect(await screen.findByText("20,000")).toBeInTheDocument();
    expect(screen.getByText("Summed across the period")).toBeInTheDocument();
  });

  it("treats zero recorded days as not available even if the sum came back 0", async () => {
    useMetrics.mockReturnValue({
      summary: summary({ impressions: 0, impression_days: 0 }),
      trend: null,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    render(<OrganicReportingPanel />);
    expect(await screen.findByText(/Not available per day/)).toBeInTheDocument();
  });
});
