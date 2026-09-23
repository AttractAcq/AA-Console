export type HistoryJob = {
  id: string;
  agent_key: string;
  input_id: string | null;
  status: string;
  cost_usd: number | null;
  created_at: string;
};

/** Newest job per agent. Expects `jobs` newest first. */
export function latestByAgent<T extends HistoryJob>(jobs: T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const job of jobs) if (!latest.has(job.agent_key)) latest.set(job.agent_key, job);
  return latest;
}

/** Total recorded spend across every job. */
export function totalSpend(jobs: HistoryJob[]): number {
  return jobs.reduce((sum, j) => sum + Number(j.cost_usd ?? 0), 0);
}

/**
 * Failures that are still outstanding: no later job of the same agent
 * covers the same input. A client-level job (no input) covers, and is
 * covered by, any run of that agent, so a strategy agent that failed and
 * was then re-run cleanly stops being reported. Expects `jobs` newest
 * first.
 */
export function unresolvedFailures<T extends HistoryJob>(jobs: T[]): T[] {
  // Per agent, the inputs already seen on newer jobs, and whether any
  // newer job was client-level.
  const later = new Map<string, { inputs: Set<string>; clientLevel: boolean }>();
  const failures: T[] = [];
  for (const job of jobs) {
    let seen = later.get(job.agent_key);
    if (!seen) {
      seen = { inputs: new Set(), clientLevel: false };
      later.set(job.agent_key, seen);
    }
    const superseded =
      seen.clientLevel ||
      (job.input_id === null ? seen.inputs.size > 0 : seen.inputs.has(job.input_id));
    if (job.status === "failed" && !superseded) failures.push(job);
    if (job.input_id === null) seen.clientLevel = true;
    else seen.inputs.add(job.input_id);
  }
  return failures;
}
