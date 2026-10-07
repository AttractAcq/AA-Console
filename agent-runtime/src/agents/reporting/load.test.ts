import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { loadMetrics, type PeriodSummary } from "./index.js";
import type { AgentJobRow } from "../../queue.js";

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

const job = {
  id: "job-1",
  client_id: "client-1",
  input_table: null,
  input_id: null,
  params: { since: "2026-09-01", until: "2026-09-30" },
} as unknown as AgentJobRow;

/** Answers metrics_period_summary by the window it was asked for. */
function database(answers: {
  current?: PeriodSummary | null;
  prior?: PeriodSummary | null;
  priorError?: string;
}) {
  const asked: Array<{ since: string; until: string }> = [];
  const rpc = vi.fn(async (name: string, args: Record<string, string>) => {
    if (name !== "metrics_period_summary") throw new Error(`unexpected rpc ${name}`);
    asked.push({ since: args.p_since!, until: args.p_until! });
    const isCurrent = args.p_since === "2026-09-01";
    if (!isCurrent && answers.priorError) {
      return { data: null, error: { message: answers.priorError } };
    }
    const data = isCurrent
      ? answers.current === undefined
        ? summary()
        : answers.current
      : answers.prior === undefined
        ? summary({ window: { since: "2026-08-02", until: "2026-08-31" } })
        : answers.prior;
    return { data, error: null };
  });
  return {
    sb: { rpc, from: vi.fn() } as unknown as SupabaseClient,
    asked,
  };
}

describe("what the commentary is given", () => {
  it("reads the period before this one as well as this one", async () => {
    // The system prompt asks it to lead with what changed and forbids
    // comparing to a period it was not given. Until now it was never given
    // one, so every write-up was a snapshot.
    const { sb, asked } = database({});
    const loaded = await loadMetrics(sb, job);

    expect(asked).toEqual([
      { since: "2026-09-01", until: "2026-09-30" },
      { since: "2026-08-02", until: "2026-08-31" },
    ]);
    expect(loaded.text).toContain("=== THE PERIOD BEFORE THIS ONE ===");
    expect(loaded.text).toContain("PAID, CHANGE");
  });

  it("still carries this period's own figures", async () => {
    const { sb } = database({});
    const loaded = await loadMetrics(sb, job);
    expect(loaded.text).toContain("Spend: ZAR 1000.00");
  });

  it("says a first window with data is not a rise from zero", async () => {
    // The difference between a trend and the ingest having started.
    const { sb } = database({ prior: summary({ total_rows: 0 }) });
    const loaded = await loadMetrics(sb, job);
    expect(loaded.text).toContain("Nothing was ingested for 2026-08-02 to 2026-08-31");
    expect(loaded.text).toMatch(/first window with data rather than a rise from zero/);
    expect(loaded.text).not.toContain("PAID, CHANGE");
  });

  it("writes the commentary anyway when the earlier window cannot be read", async () => {
    // A new feature must not be able to break an old one. The write-up is
    // still worth having without a trend.
    const { sb } = database({ priorError: "statement timeout" });
    const loaded = await loadMetrics(sb, job);
    expect(loaded.block).toBeUndefined();
    expect(loaded.text).toContain("Spend: ZAR 1000.00");
    expect(loaded.text).toMatch(/no comparison to make/);
  });

  it("still blocks when this period has nothing in it", async () => {
    const { sb } = database({ current: summary({ total_rows: 0 }) });
    const loaded = await loadMetrics(sb, job);
    expect(loaded.block).toMatch(/No metrics have been ingested/);
    expect(loaded.text).toBe("");
  });
});
