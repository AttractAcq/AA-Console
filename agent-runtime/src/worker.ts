// The claim loop. One instance per concurrency slot, all in one process.
//
// Every iteration is independent and crash-safe: if the process dies
// mid-job the lease simply expires and claim_agent_job picks the job back
// up once lease_until passes. There is deliberately no reconciler — the
// lease IS the recovery mechanism.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "./config.js";
import {
  appendEvent,
  claimNextJob,
  markJobCompleted,
  markJobFailed,
  markJobRunning,
  renewJobLease,
  type AgentJobRow,
} from "./queue.js";
import { getAgent } from "./orchestration/registry.js";
import { dispatchJob, hasRunner, registeredAgentKeys } from "./orchestration/dispatch.js";
import { logger } from "./logging/logger.js";

export interface WorkerHandle {
  stop: () => Promise<void>;
}

export function startWorker(
  sb: SupabaseClient,
  config: RuntimeConfig,
  workerIndex: number,
): WorkerHandle {
  const leaseOwner = `agent-runtime:${process.pid}:${workerIndex}:${crypto.randomUUID()}`;
  let stopped = false;

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        // Only claim what this build can actually run. claim_agent_job has
        // always accepted this filter; not passing it meant a worker would
        // claim an agent it had no runner for and burn the job's attempts
        // on NO_RUNTIME_IMPLEMENTATION. That makes registering an agent row
        // before its runner ships a destructive act, and during a rolling
        // deploy the old container would eat the new agent's jobs. Now such
        // a job simply waits for a build that knows how to run it.
        const job = await claimNextJob(sb, leaseOwner, config.leaseSeconds, registeredAgentKeys());
        if (!job) {
          await sleep(config.emptyQueueBackoffMs);
          continue;
        }
        await runOneJob(sb, config, job, leaseOwner);
      } catch (error) {
        logger.error("worker_loop_error", {
          workerIndex,
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(config.emptyQueueBackoffMs);
      }
    }
  }

  const running = loop();
  logger.info("worker_started", { workerIndex, leaseOwner });

  return {
    stop: async () => {
      stopped = true;
      await running;
    },
  };
}

async function runOneJob(
  sb: SupabaseClient,
  config: RuntimeConfig,
  job: AgentJobRow,
  leaseOwner: string,
): Promise<void> {
  logger.info("job_claimed", {
    jobId: job.id,
    agentKey: job.agent_key,
    clientId: job.client_id,
    attempt: job.attempts,
  });

  // Fail loudly rather than holding a job no code can run.
  if (!hasRunner(job.agent_key)) {
    const message = `No runtime implementation for agent "${job.agent_key}".`;
    await markJobFailed(sb, job.id, leaseOwner, job.attempts, job.max_attempts, false, message);
    await appendEvent(sb, job.id, message, "error", { failure_code: "NO_RUNTIME_IMPLEMENTATION" });
    logger.warn("job_no_runner", { jobId: job.id, agentKey: job.agent_key });
    return;
  }

  const agent = await getAgent(sb, job.agent_key);
  await markJobRunning(sb, job.id, leaseOwner);
  await appendEvent(sb, job.id, `${agent.name} started.`, "info", { agent_key: job.agent_key });

  const renewal = startLeaseRenewal(sb, config, job.id, leaseOwner);

  try {
    const result = await dispatchJob(sb, config, agent, job);
    renewal.stop();

    if (result.ok) {
      await markJobCompleted(sb, job.id, leaseOwner, result.usage);
      await appendEvent(sb, job.id, `${agent.name} completed.`, "info", result.usage ?? {});
      logger.info("job_completed", { jobId: job.id, agentKey: job.agent_key, usage: result.usage });
    } else {
      const message = result.failureMessage ?? "Unknown failure.";
      await markJobFailed(
        sb,
        job.id,
        leaseOwner,
        job.attempts,
        job.max_attempts,
        result.retryable,
        message,
        result.usage,
      );
      await appendEvent(sb, job.id, message, "error", { retryable: result.retryable });
      logger.warn("job_failed", {
        jobId: job.id,
        agentKey: job.agent_key,
        retryable: result.retryable,
      });
    }
  } catch (error) {
    renewal.stop();
    const message = error instanceof Error ? error.message : String(error);
    // An unexpected throw is retryable while attempts remain — the next
    // claim will pick it up rather than losing the work.
    const retryable = job.attempts < job.max_attempts;
    await markJobFailed(
      sb,
      job.id,
      leaseOwner,
      job.attempts,
      job.max_attempts,
      retryable,
      message,
    );
    await appendEvent(sb, job.id, message, "error", {
      failure_code: "RUNTIME_EXCEPTION",
      retryable,
    });
    logger.error("job_threw", { jobId: job.id, agentKey: job.agent_key, error: message });
  }
}

function startLeaseRenewal(
  sb: SupabaseClient,
  config: RuntimeConfig,
  jobId: string,
  leaseOwner: string,
): { stop: () => void } {
  // A third of the lease gives two chances to renew before it lapses.
  const intervalMs = Math.max(10_000, Math.floor((config.leaseSeconds * 1000) / 3));
  const startedAt = Date.now();

  async function renew(): Promise<void> {
    // The lease is the recovery mechanism for a dead worker — but renewal by
    // a LIVE worker holding a stalled call defeats it, because the lease
    // never lapses and the job can never be reclaimed. So renewal is capped:
    // past this age the lease is allowed to expire and another worker takes
    // the job. The stale run cannot corrupt anything when it finally returns,
    // because every write asserts it still owns the lease.
    const ageSeconds = Math.round((Date.now() - startedAt) / 1000);
    if (ageSeconds > config.maxJobSeconds) {
      logger.error("job_lease_renewal_capped", {
        jobId,
        leaseOwner,
        ageSeconds,
        maxJobSeconds: config.maxJobSeconds,
        reason: "job exceeded its maximum age; letting the lease lapse so it can be reclaimed",
      });
      clearInterval(interval);
      return;
    }

    try {
      const renewed = await renewJobLease(sb, jobId, leaseOwner, config.leaseSeconds);
      if (!renewed) {
        // Someone else owns this job now. Stop renewing; the run will fail
        // its next write on the count===1 assertion, which is correct.
        logger.warn("job_lease_lost", { jobId, leaseOwner });
        clearInterval(interval);
      }
    } catch (error) {
      logger.error("job_lease_renewal_failed", {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const interval = setInterval(() => void renew(), intervalMs);
  interval.unref();
  return { stop: () => clearInterval(interval) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
