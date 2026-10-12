import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "../config.js";
import { logger } from "../logging/logger.js";
import { dispatchOneRecoveryAlert } from "./recovery-alerts.js";

const INTERVAL_MS = 15_000;

export interface WorkflowReconcilerHandle {
  stop: () => Promise<void>;
}

/** Bounded DB reconciliation; agent_jobs remains the only execution queue. */
export function startWorkflowReconciler(sb: SupabaseClient, config: RuntimeConfig): WorkflowReconcilerHandle {
  let stopped = false;
  let current: Promise<void> | null = null;
  const workerId = `v5-recovery-${randomUUID()}`;

  function tick(): void {
    if (stopped || current) return;
    current = (async () => {
      try {
        const { data, error } = await sb.rpc("reconcile_workflow_runs", { p_limit: 100 });
        if (error) throw new Error(error.message);
        const row = Array.isArray(data) ? data[0] : data;
        const counts = row as {
          steps_queued?: number;
          steps_for_qa?: number;
          steps_blocked?: number;
        } | null;
        if (counts && (counts.steps_queued || counts.steps_for_qa || counts.steps_blocked)) {
          logger.info("v5_workflow_reconciled", counts);
        }
        const { data: qaData, error: qaError } = await sb.rpc("accept_ready_daily_workflow_steps", { p_limit: 20 });
        if (qaError) throw new Error(qaError.message);
        const qa = (Array.isArray(qaData) ? qaData[0] : qaData) as {
          steps_accepted?: number; steps_blocked?: number;
        } | null;
        if (qa && (qa.steps_accepted || qa.steps_blocked)) {
          logger.info("v5_daily_internal_qa", qa);
        }
        await dispatchOneRecoveryAlert(sb, config, workerId);
      } catch (error) {
        logger.error("v5_workflow_reconcile_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        current = null;
      }
    })();
  }

  tick();
  const interval = setInterval(tick, INTERVAL_MS);
  interval.unref();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(interval);
      await current;
    },
  };
}
