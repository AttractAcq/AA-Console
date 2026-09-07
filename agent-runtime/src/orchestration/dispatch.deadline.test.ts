import { describe, expect, it, vi, beforeEach } from "vitest";

// Stand in for one real agent so we can see exactly what dispatch hands a
// runner. Mocking the agent rather than the registry means this tests the
// real wiring: if dispatchJob stopped passing a deadline, or passed something
// unbounded, this notices.
const { runner } = vi.hoisted(() => ({ runner: vi.fn() }));
vi.mock("../agents/metrics_ingest/index.js", () => ({ runMetricsIngestJob: runner }));

import { dispatchJob } from "./dispatch.js";
import type { RuntimeConfig } from "../config.js";
import type { AgentRow } from "./registry.js";
import type { AgentJobRow } from "../queue.js";

const job = { id: "j1", agent_key: "metrics_ingest", client_id: "c1" } as AgentJobRow;
const agent = { agent_key: "metrics_ingest" } as AgentRow;
const sb = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  runner.mockResolvedValue({ ok: true, retryable: false });
});

describe("dispatchJob", () => {
  it("hands the runner a deadline derived from maxJobSeconds", async () => {
    const config = { maxJobSeconds: 1800 } as RuntimeConfig;
    const before = Date.now();
    await dispatchJob(sb, config, agent, job);
    const after = Date.now();

    expect(runner).toHaveBeenCalledOnce();
    const deadlineAt = (runner.mock.calls[0]?.[4] as number);
    expect(deadlineAt).toBeGreaterThanOrEqual(before + 1_800_000);
    expect(deadlineAt).toBeLessThanOrEqual(after + 1_800_000);
  });

  // The mutation that slipped through before: an unbounded deadline is a
  // deadline in name only, and every other test still passed.
  it("never hands out an unbounded deadline", async () => {
    const config = { maxJobSeconds: 60 } as RuntimeConfig;
    await dispatchJob(sb, config, agent, job);
    const deadlineAt = (runner.mock.calls[0]?.[4] as number);
    expect(Number.isFinite(deadlineAt)).toBe(true);
    expect(deadlineAt).toBeLessThan(Date.now() + 120_000);
  });

  it("shortens with a shorter configured maximum", async () => {
    await dispatchJob(sb, { maxJobSeconds: 60 } as RuntimeConfig, agent, job);
    await dispatchJob(sb, { maxJobSeconds: 1800 } as RuntimeConfig, agent, job);
    const short = (runner.mock.calls[0]?.[4] as number);
    const long = (runner.mock.calls[1]?.[4] as number);
    expect(long - short).toBeGreaterThan(1_700_000);
  });
});
