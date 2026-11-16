import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../logging/logger.js";

/** Download the exact new PDF before its workflow step can pass internal QA. */
export async function attestCampaignMagnetWorkflowOutputs(sb: SupabaseClient): Promise<number> {
  const runs = await sb.from("workflow_runs").select("id,client_id")
    .eq("kind", "campaign_sweep").eq("status", "needs_internal_qa").limit(20);
  if (runs.error) throw new Error(runs.error.message);
  if (!runs.data?.length) return 0;
  const steps = await sb.from("workflow_steps").select("id,run_id,job_id,resolved_input_id")
    .in("run_id", runs.data.map((r) => r.id))
    .eq("step_key", "conversion_lead_magnet")
    .eq("status", "needs_internal_qa").limit(10);
  if (steps.error) throw new Error(steps.error.message);
  let count = 0;
  for (const step of steps.data ?? []) {
    const clientId = runs.data.find((r) => r.id === step.run_id)?.client_id;
    if (!clientId || !step.job_id || !step.resolved_input_id) continue;
    const version = await sb.from("lead_magnet_versions")
      .select("id,client_id,storage_path,content_sha256,file_bytes")
      .eq("magnet_id", step.resolved_input_id).eq("client_id", clientId)
      .eq("created_by_job_id", step.job_id).maybeSingle();
    if (version.error) throw new Error(version.error.message);
    if (!version.data) continue;
    const checked = await sb.from("campaign_magnet_byte_checks_v7")
      .select("version_id").eq("version_id", version.data.id).maybeSingle();
    if (checked.error) throw new Error(checked.error.message);
    if (checked.data) continue;
    try {
      const file = await sb.storage.from("client-media").download(version.data.storage_path);
      if (file.error || !file.data) throw new Error(file.error?.message ?? "Stored file unavailable.");
      const bytes = Buffer.from(await file.data.arrayBuffer());
      if (bytes.length < 100 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
        throw new Error("Stored magnet is not a complete PDF.");
      }
      const hash = createHash("sha256").update(bytes).digest("hex");
      // Store what was observed, even on a mismatch, so SQL can hold the
      // workflow with an explicit reason rather than waiting indefinitely.
      const saved = await sb.from("campaign_magnet_byte_checks_v7").insert({
        version_id: version.data.id, client_id: clientId, job_id: step.job_id,
        content_sha256: hash, file_bytes: bytes.length,
      });
      if (saved.error) throw new Error(saved.error.message);
      count += 1;
    } catch (cause) {
      logger.warn("campaign_magnet_attestation_pending", { step_id: step.id,
        error: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  return count;
}
