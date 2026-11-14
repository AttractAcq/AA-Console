// Self-reported liveness, written every 30s REGARDLESS of whether worker
// loops are enabled. "Alive but disabled" is a real state, distinct from
// "crashed" and from "never deployed", and the console should be able to
// tell them apart.

import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "./config.js";
import { logger } from "./logging/logger.js";
import { deployedCommitSha } from "./readiness/version.js";
import { GENERIC_CAMPAIGN_ACTION_CLAIM_HOLD } from "./campaigns/actions/preclaim-hold.js";
import { HANDLERS } from "./campaigns/actions/executor.js";
import { ACTION_HANDLER_MODULES } from "./campaigns/actions/handler-ownership.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

export interface HeartbeatHandle {
  workerId: string;
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
  const handlers = Object.fromEntries(Object.keys(HANDLERS)
    .map((key) => [key, ACTION_HANDLER_MODULES[key as keyof typeof ACTION_HANDLER_MODULES]])
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));

  async function campaignActionHold(): Promise<string> {
    if (!config.campaignActionOwnedClaimEnabled) return GENERIC_CAMPAIGN_ACTION_CLAIM_HOLD;
    if (!version) return "Campaign action claims need a complete deployed Git commit SHA.";
    if (!config.enabled || !config.campaignActionsEnabled) return "Campaign action runtime switch is off.";
    const { data, error } = await sb.from("campaign_action_executors")
      .select("action_key,executor_module,supported,handler_attested_sha")
      .in("action_key", Object.keys(handlers));
    if (error || !data || data.length !== Object.keys(handlers).length) {
      return "Campaign action handler registry could not be verified.";
    }
    for (const row of data) {
      if (!row.supported || row.handler_attested_sha !== version
        || handlers[row.action_key] !== row.executor_module) {
        return "Campaign action handler registry is not attested to this deployed build.";
      }
    }
    return "";
  }

  async function tick(): Promise<void> {
    try {
      const [queued, active, actionHold] = await Promise.all([
        sb.from("agent_jobs").select("id", { count: "exact", head: true }).eq("status", "queued"),
        sb
          .from("agent_jobs")
          .select("id", { count: "exact", head: true })
          .in("status", ["claimed", "running"]),
        campaignActionHold(),
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
          controls: {
            publish: config.publishEnabled,
            proofPublish: config.proofPublishEnabled,
            googleReviewReply: config.googleReviewReplyEnabled,
            campaignActions: config.campaignActionsEnabled,
            outboundMessaging: config.outboundMessagingEnabled,
            leadMagnetDelivery: config.leadMagnetDeliveryEnabled,
          },
          holds: actionHold ? { campaignActions: actionHold } : {},
          handlers,
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
  return { workerId, stop: () => clearInterval(interval) };
}
