import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../logging/logger.js";
import { attestCreativeAssetBytes } from "./attest-asset-route.js";

type Run = { id: string; client_id: string };
type Step = {
  id: string; run_id: string; agent_key: string;
  resolved_input_id: string | null; job_id: string | null;
};
type Job = { id: string; status: string; created_at: string };
type Asset = { id: string; delivery_bytes_sha256: string | null };

/** Attest bounded campaign outputs before SQL internal QA accepts their bytes. */
export async function attestCampaignCreativeWorkflowOutputs(sb: SupabaseClient): Promise<number> {
  const runs = await sb.from("workflow_runs").select("id, client_id")
    .eq("kind", "campaign_sweep").eq("status", "needs_internal_qa").limit(20);
  if (runs.error) throw new Error(runs.error.message);
  const active = (runs.data ?? []) as Run[];
  if (!active.length) return 0;
  const stepsResult = await sb.from("workflow_steps")
    .select("id, run_id, agent_key, resolved_input_id, job_id")
    .in("run_id", active.map((run) => run.id))
    .eq("status", "needs_internal_qa")
    .in("agent_key", ["creative_build", "video_edit"])
    .limit(10);
  if (stepsResult.error) throw new Error(stepsResult.error.message);
  const steps = (stepsResult.data ?? []) as Step[];
  if (!steps.length) return 0;
  const jobIds = steps.map((step) => step.job_id).filter((id): id is string => !!id);
  if (!jobIds.length) return 0;
  const jobsResult = await sb.from("agent_jobs").select("id, status, created_at")
    .in("id", jobIds);
  if (jobsResult.error) throw new Error(jobsResult.error.message);
  const jobs = new Map(((jobsResult.data ?? []) as Job[]).map((job) => [job.id, job]));
  const clients = new Map(active.map((run) => [run.id, run.client_id]));
  let attested = 0;
  for (const step of steps) {
    const job = jobs.get(step.job_id ?? "");
    const clientId = clients.get(step.run_id);
    if (!job || job.status !== "completed" || !clientId || !step.resolved_input_id) continue;
    const query = sb.from("client_media_assets")
      .select("id, delivery_bytes_sha256").eq("client_id", clientId);
    const assetResult = step.agent_key === "video_edit"
      ? await query.eq("id", step.resolved_input_id).limit(2)
      : await query.eq("brief_id", step.resolved_input_id)
        .gte("created_at", job.created_at).limit(2);
    if (assetResult.error) throw new Error(assetResult.error.message);
    const assets = (assetResult.data ?? []) as Asset[];
    const asset = assets.length === 1 ? assets[0] : undefined;
    if (!asset || asset.delivery_bytes_sha256) continue;
    try {
      await attestCreativeAssetBytes(sb, clientId, asset.id);
      attested += 1;
    } catch (cause) {
      logger.warn("campaign_creative_attestation_pending", {
        step_id: step.id, asset_id: asset.id,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return attested;
}
