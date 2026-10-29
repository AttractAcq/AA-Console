// Self-reported liveness, written every 30s REGARDLESS of whether worker
// loops are enabled. "Alive but disabled" is a real state, distinct from
// "crashed" and from "never deployed", and the console should be able to
// tell them apart.

import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "./config.js";
import { logger } from "./logging/logger.js";
import { deployedCommitSha } from "./readiness/version.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

export interface HeartbeatHandle {
  stop: () => void;
}

/** A process identity must survive identical PIDs across container replicas. */
export function makeHeartbeatWorkerId(pid = process.pid, instanceId = randomUUID()): string {
  return `agent-runtime:${pid}:${instanceId}`;
}

export function startHeartbeat(
  sb: SupabaseClient,
  config: RuntimeConfig,
  workerCount: number,
): HeartbeatHandle {
  const workerId = makeHeartbeatWorkerId();
  const version = deployedCommitSha();

  async function tick(): Promise<void> {
    try {
      const [queued, active] = await Promise.all([
        sb.from("agent_jobs").select("id", { count: "exact", head: true }).eq("status", "queued"),
        sb
          .from("agent_jobs")
          .select("id", { count: "exact", head: true })
          .in("status", ["claimed", "running"]),
      ]);
      const { error } = await sb.from("agent_runtime_heartbeats").insert({
        worker_id: workerId,
        status: "healthy",
        version,
        queue_depth: queued.count ?? null,
        active_jobs: active.count ?? null,
        metadata: {
          enabled: config.enabled,
          concurrency: workerCount,
          model: config.model,
          pid: process.pid,
        },
      });
      if (error) logger.error("heartbeat_write_failed", { error: error.message });
    } catch (error) {
      logger.error("heartbeat_tick_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  void tick();
  const interval = setInterval(() => void tick(), HEARTBEAT_INTERVAL_MS);
  interval.unref();
  return { stop: () => clearInterval(interval) };
}
