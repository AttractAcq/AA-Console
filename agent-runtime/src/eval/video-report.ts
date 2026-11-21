import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

export type BatchResult = { id: string; estimatedCostUsd: number;
  error: string | null };
export type BatchState<T extends BatchResult> = { results: T[];
  activeCaseId: string | null;
  status: "running" | "complete" | "budget_stop" | "billing_unknown_stop" };

export function selectCaseRange<T extends { id: string }>(cases: T[],
  start: number, limit: number): T[] {
  if (!Number.isInteger(start) || start < 1 || start > cases.length
    || !Number.isInteger(limit) || limit < 1
    || start + limit - 1 > cases.length) {
    throw new Error(`Select --start 1..${cases.length} and --limit within the remaining cases. No model call was made.`);
  }
  return cases.slice(start - 1, start - 1 + limit);
}

/** Save a running-case marker before the provider call. If the process dies,
 * the report identifies the case whose billing and outcome need reconciliation.
 * A provider error with unknown billing stops the batch before another call.
 */
export async function runEvaluationBatch<T extends BatchResult, C extends { id: string }>(
  cases: C[], maxUsd: number,
  evaluate: (test: C) => Promise<T>,
  persist: (state: BatchState<T>) => Promise<void>,
): Promise<BatchState<T>> {
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) {
    throw new Error("Video evaluation budget must be positive.");
  }
  const results: T[] = [];
  let estimatedCostUsd = 0;
  const save = async (status: BatchState<T>["status"], activeCaseId: string | null) => {
    const state = { results: [...results], activeCaseId, status };
    await persist(state);
    return state;
  };
  for (const test of cases) {
    if (estimatedCostUsd >= maxUsd) return save("budget_stop", null);
    await save("running", test.id);
    const result = await evaluate(test);
    if (result.id !== test.id || !Number.isFinite(result.estimatedCostUsd)
      || result.estimatedCostUsd < 0) {
      throw new Error("Video evaluation returned an invalid case or cost; reconcile the active case.");
    }
    results.push(result);
    estimatedCostUsd += result.estimatedCostUsd;
    if (result.error === "provider_or_runtime_error") {
      return save("billing_unknown_stop", null);
    }
    await save("running", null);
  }
  return save("complete", null);
}

export async function reserveJsonReport(path: string, report: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(report, null, 2) + "\n",
    { flag: "wx", mode: 0o600 });
}

export async function replaceJsonReport(path: string, report: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(report, null, 2) + "\n",
      { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
