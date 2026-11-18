import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "../config.js";
import { logger } from "../logging/logger.js";
import { dispatchOneRecoveryAlert } from "./recovery-alerts.js";
import { attestCampaignCreativeWorkflowOutputs } from "../creative/attest-campaign-workflow.js";
import { attestCampaignMagnetWorkflowOutputs } from "../lead-magnets/attest-campaign-workflow.js";

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
        const attested = await attestCampaignCreativeWorkflowOutputs(sb);
        if (attested > 0) logger.info("campaign_creative_bytes_attested", { count: attested });
        const magnetAttested = await attestCampaignMagnetWorkflowOutputs(sb);
        if (magnetAttested > 0) logger.info("campaign_magnet_bytes_attested", { count: magnetAttested });
        const { data: googleCopyQa, error: googleCopyQaError } = await sb.rpc(
          "accept_ready_google_search_copy_steps_v7", { p_limit: 20 },
        );
        if (googleCopyQaError) throw new Error(googleCopyQaError.message);
        const googleCopyCounts = (Array.isArray(googleCopyQa) ? googleCopyQa[0] : googleCopyQa) as {
          steps_accepted?: number; steps_blocked?: number;
        } | null;
        if (googleCopyCounts && (googleCopyCounts.steps_accepted || googleCopyCounts.steps_blocked)) {
          logger.info("google_search_copy_internal_qa", googleCopyCounts);
        }
        const { data: campaignQaData, error: campaignQaError } = await sb.rpc(
          "accept_ready_campaign_workflow_steps_v7", { p_limit: 20 },
        );
        if (campaignQaError) throw new Error(campaignQaError.message);
        const campaignQa = (Array.isArray(campaignQaData) ? campaignQaData[0] : campaignQaData) as {
          steps_accepted?: number; steps_blocked?: number;
        } | null;
        if (campaignQa && (campaignQa.steps_accepted || campaignQa.steps_blocked)) {
          logger.info("campaign_sweep_internal_qa", campaignQa);
        }
        const { data: conversionQaData, error: conversionQaError } = await sb.rpc(
          "accept_ready_campaign_conversion_steps_v7", { p_limit: 20 },
        );
        if (conversionQaError) throw new Error(conversionQaError.message);
        const conversionQa = (Array.isArray(conversionQaData) ? conversionQaData[0]
          : conversionQaData) as { steps_accepted?: number; steps_blocked?: number } | null;
        if (conversionQa && (conversionQa.steps_accepted || conversionQa.steps_blocked)) {
          logger.info("campaign_conversion_internal_qa", conversionQa);
        }
        const { data: magnetQa, error: magnetQaError } = await sb.rpc(
          "accept_ready_campaign_magnet_steps_v7", { p_limit: 20 },
        );
        if (magnetQaError) throw new Error(magnetQaError.message);
        const magnetCounts = (Array.isArray(magnetQa) ? magnetQa[0] : magnetQa) as {
          steps_accepted?: number; steps_blocked?: number;
        } | null;
        if (magnetCounts && (magnetCounts.steps_accepted || magnetCounts.steps_blocked)) {
          logger.info("campaign_magnet_internal_qa", magnetCounts);
        }
        const { data: googleCopyWork, error: googleCopyWorkError } = await sb.rpc(
          "sync_google_search_copy_work_v7", { p_limit: 100 },
        );
        if (googleCopyWorkError) throw new Error(googleCopyWorkError.message);
        if (typeof googleCopyWork === "number" && googleCopyWork > 0) {
          logger.info("google_search_copy_work_synced", { count: googleCopyWork });
        }
        const { data: workSynced, error: workError } = await sb.rpc(
          "sync_campaign_sweep_work_v7", { p_limit: 100 },
        );
        if (workError) throw new Error(workError.message);
        if (typeof workSynced === "number" && workSynced > 0) {
          logger.info("campaign_sweep_work_synced", { count: workSynced });
        }
        const { data: conversionSynced, error: conversionWorkError } = await sb.rpc(
          "sync_campaign_conversion_work_v7", { p_limit: 100 },
        );
        if (conversionWorkError) throw new Error(conversionWorkError.message);
        if (typeof conversionSynced === "number" && conversionSynced > 0) {
          logger.info("campaign_conversion_work_synced", { count: conversionSynced });
        }
        const { data: magnetSynced, error: magnetWorkError } = await sb.rpc(
          "sync_campaign_magnet_work_v7", { p_limit: 100 },
        );
        if (magnetWorkError) throw new Error(magnetWorkError.message);
        if (typeof magnetSynced === "number" && magnetSynced > 0) {
          logger.info("campaign_magnet_work_synced", { count: magnetSynced });
        }
        const { data: siblings, error: siblingError } = await sb.rpc(
          "settle_completed_blocked_daily_siblings", { p_limit: 5 },
        );
        if (siblingError) throw new Error(siblingError.message);
        if (typeof siblings === "number" && siblings > 0) {
          logger.info("v5_blocked_daily_siblings_accepted", { count: siblings });
        }
        const { data: rebuilt, error: rebuildError } = await sb.rpc("auto_rebuild_rejected_reel_sources", { p_limit: 3 });
        if (rebuildError) throw new Error(rebuildError.message);
        if (typeof rebuilt === "number" && rebuilt > 0) {
          logger.info("v5_reel_sources_rebuilt", { count: rebuilt });
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
