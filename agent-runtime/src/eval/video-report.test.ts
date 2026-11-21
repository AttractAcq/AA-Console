import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { replaceJsonReport, reserveJsonReport, runEvaluationBatch,
  selectCaseRange } from "./video-report.js";

describe("paid video evaluation batches", () => {
  const cases = Array.from({ length: 20 }, (_, index) => ({
    id: String(index + 1).padStart(2, "0") }));

  it("selects the later ten without rerunning the first ten", () => {
    expect(selectCaseRange(cases, 11, 10).map((test) => test.id))
      .toEqual(cases.slice(10).map((test) => test.id));
    expect(() => selectCaseRange(cases, 11, 11)).toThrow(/remaining cases/);
    expect(() => selectCaseRange(cases, 0, 1)).toThrow(/--start/);
    expect(() => selectCaseRange(cases, 1, 0)).toThrow(/--limit/);
  });

  it("persists the active case before each provider call and stops on unknown billing", async () => {
    const snapshots: Array<{ activeCaseId: string | null; status: string;
      results: string[] }> = [];
    const evaluate = vi.fn(async (test: { id: string }) => ({ id: test.id,
      estimatedCostUsd: 0.3,
      error: test.id === "02" ? "provider_or_runtime_error" : null }));
    const state = await runEvaluationBatch(cases.slice(0, 3), 2, evaluate,
      async (current) => { snapshots.push({ activeCaseId: current.activeCaseId,
        status: current.status, results: current.results.map((result) => result.id) }); });
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(state.status).toBe("billing_unknown_stop");
    expect(state.results.map((result) => result.id)).toEqual(["01", "02"]);
    expect(snapshots).toContainEqual({ activeCaseId: "01",
      status: "running", results: [] });
    expect(snapshots).toContainEqual({ activeCaseId: "02",
      status: "running", results: ["01"] });
    expect(snapshots.at(-1)).toEqual({ activeCaseId: null,
      status: "billing_unknown_stop", results: ["01", "02"] });
  });

  it("stops between cases when one case exceeds the estimated threshold", async () => {
    const evaluate = vi.fn(async (test: { id: string }) => ({ id: test.id,
      estimatedCostUsd: 1, error: null }));
    const state = await runEvaluationBatch(cases.slice(0, 2), 0.5,
      evaluate, async () => {});
    expect(state.status).toBe("budget_stop");
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("preserves an in-flight marker if evaluation fails before a result", async () => {
    const snapshots: string[] = [];
    await expect(runEvaluationBatch(cases.slice(0, 1), 1,
      async () => { throw new Error("abrupt provider exit"); },
      async (state) => { snapshots.push(state.activeCaseId ?? "none"); }))
      .rejects.toThrow(/abrupt provider exit/);
    expect(snapshots).toEqual(["01"]);
  });

  it("reserves a private report and atomically replaces it without overwriting another run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aa-video-eval-report-"));
    const path = join(directory, "report.json");
    try {
      await reserveJsonReport(path, { activeCaseId: null });
      await expect(reserveJsonReport(path, {})).rejects.toThrow();
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await replaceJsonReport(path, { activeCaseId: "01" });
      expect(JSON.parse(await readFile(path, "utf8")))
        .toEqual({ activeCaseId: "01" });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
