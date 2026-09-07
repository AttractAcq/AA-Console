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
export function deadlineFromNow(config: RuntimeConfig): number {
  return Date.now() + config.maxJobSeconds * 1000;
}
