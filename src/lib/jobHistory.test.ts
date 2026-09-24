import { describe, expect, it } from "vitest";
import { latestByAgent, totalSpend, unresolvedFailures, type HistoryJob } from "./jobHistory";

let n = 0;
function job(agent_key: string, status: string, input_id: string | null = null, cost_usd: number | null = null): HistoryJob {
  n += 1;
  return { id: `j${n}`, agent_key, input_id, status, cost_usd, created_at: "" };
}

describe("latestByAgent", () => {
  it("keeps the first (newest) job per agent", () => {
    const newest = job("icp", "completed");
    const map = latestByAgent([newest, job("icp", "failed"), job("brief", "completed")]);
    expect(map.get("icp")).toBe(newest);
    expect(map.size).toBe(2);
  });
});

describe("totalSpend", () => {
  it("sums every job, treating null as zero", () => {
    expect(totalSpend([job("a", "completed", null, 0.5), job("b", "failed", null, null), job("c", "completed", null, 1.25)])).toBe(1.75);
  });
});

describe("unresolvedFailures", () => {
  it("drops a failure a later run of the same agent and input superseded", () => {
    const jobs = [job("brief", "completed", "x"), job("brief", "failed", "x")];
    expect(unresolvedFailures(jobs)).toEqual([]);
  });

  it("keeps a failure when the retry was for a different input", () => {
    const failed = job("brief", "failed", "y");
    expect(unresolvedFailures([job("brief", "completed", "x"), failed])).toEqual([failed]);
  });

  it("treats a client-level run as covering any input of that agent", () => {
    expect(unresolvedFailures([job("competitor", "completed", "x"), job("competitor", "failed")])).toEqual([]);
    expect(unresolvedFailures([job("competitor", "completed"), job("competitor", "failed", "x")])).toEqual([]);
  });

  it("keeps failures of other agents", () => {
    const failed = job("proof", "failed");
    expect(unresolvedFailures([job("icp", "completed"), failed])).toEqual([failed]);
  });

  it("reports repeated failures on one input once", () => {
    const latest = job("icp", "failed");
    expect(unresolvedFailures([latest, job("icp", "failed")])).toEqual([latest]);
  });
});
