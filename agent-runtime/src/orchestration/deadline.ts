import type { RuntimeConfig } from "../config.js";

/**
 * The moment a job must stop working, whatever it is in the middle of.
 *
 * Deliberately the same bound the worker uses to stop renewing the lease.
 * Before, only renewal stopped: the job kept running, so a wedged attempt
 * became a zombie that held a worker slot and kept spending while a second
 * worker was free to claim the same row. Writes were safe — every one asserts
 * lease ownership — but the work was not bounded and neither was the cost.
 * Stopping execution at the same instant the lease stops being renewed closes
 * that gap.
 *
 * Anchored at the moment dispatch hands the job to its runner, so a retry
 * gets a fresh deadline and time spent loading context counts against it.
 */
export function maxJobSecondsForAgent(config: RuntimeConfig,
  agentKey?: string): number {
  // One video job may render three separate aspects. Its provider handles are
  // durable, so a recycled worker resumes rather than starting another paid
  // render. Keep this exception scoped to that one agent.
  return agentKey === "video_render"
    ? Math.max(config.maxJobSeconds, 4 * 60 * 60)
    : config.maxJobSeconds;
}

export function deadlineFromNow(config: RuntimeConfig,
  agentKey?: string): number {
  return Date.now() + maxJobSecondsForAgent(config, agentKey) * 1000;
}
