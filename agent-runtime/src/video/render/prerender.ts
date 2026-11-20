import type { AwsRegion } from "@remotion/lambda";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import { anthropicKeyForAgent } from "../../config.js";
import { applyCriticPatch } from "./critic-patch.js";
import { brandRules } from "./finalize.js";
import { buildVideoRenderInputs } from "./inputs.js";
import { reviewPreRenderStills } from "./prerender-critic.js";
import { renderPreRenderStills } from "./prerender-stills.js";
import type { VideoAspect } from "./probe.js";
import type { PreRenderCriticReport } from "./prerender-critic.js";

type Dependencies = { prepare: typeof buildVideoRenderInputs;
  stills: typeof renderPreRenderStills;
  review: typeof reviewPreRenderStills };
const defaults: Dependencies = { prepare: buildVideoRenderInputs,
  stills: renderPreRenderStills, review: reviewPreRenderStills };

export class PreRenderReviewHeldError extends Error {}

async function continueFailedReview(input: {
  sb: SupabaseClient; attemptId: string; jobId: string;
  irVersion: number; ir: unknown; report: PreRenderCriticReport;
}): Promise<"fail" | "revised"> {
  const resolution = await input.sb.rpc("resolve_video_project_critic_failure_v1", {
    p_attempt_id: input.attemptId, p_job_id: input.jobId });
  if (resolution.error) {
    throw new PreRenderReviewHeldError(
      "Failed pre-render review could not be resolved from its exact receipt.");
  }
  if (resolution.data === "needs_human") return "fail";
  if (!["visual_patch", "timing_required"].includes(resolution.data)
    || !Array.isArray(input.report.patch)
    || input.report.patch.length === 0) {
    throw new PreRenderReviewHeldError(
      "Failed pre-render review has no supported critic patch.");
  }
  let revised: ReturnType<typeof applyCriticPatch>;
  try { revised = applyCriticPatch(input.ir, input.report.patch); }
  catch {
    throw new PreRenderReviewHeldError(
      "Filed visual patch no longer validates against the exact IR.");
  }
  if (revised.narrationChanged !== (resolution.data === "timing_required")) {
    throw new PreRenderReviewHeldError(
      "Filed critic resolution disagrees with the proposed narration change.");
  }
  const rpc = revised.narrationChanged
    ? "apply_video_project_narration_patch_v1"
    : "apply_video_project_visual_patch_v1";
  const committed = await input.sb.rpc(rpc, {
    p_attempt_id: input.attemptId, p_job_id: input.jobId,
    p_expected_ir_version: input.irVersion, p_new_ir: revised.ir });
  if (committed.error
    || committed.data?.ir_version !== input.irVersion + 1
    || (revised.narrationChanged
      ? !Array.isArray(committed.data?.job_ids)
        || committed.data.job_ids.length === 0
        || committed.data.job_ids.some((id: unknown) => typeof id !== "string")
      : typeof committed.data?.job_id !== "string")) {
    throw new PreRenderReviewHeldError(
      "Critic patch and successor jobs were not committed together.");
  }
  return "revised";
}

/** One exact billable pre-render attempt. A retry may read a decided pass,
 * but a claimed or uncertain attempt never repeats Lambda or the model.
 */
export async function runPreRenderCritic(input: {
  sb: SupabaseClient; config: RuntimeConfig;
  clientId: string; projectId: string; jobId: string;
  irVersion: number; aspect: VideoAspect;
  region: AwsRegion; functionName: string; serveUrl: string;
  maxAlignmentLoss: number;
}, deps: Dependencies = defaults): Promise<"pass" | "fail" | "revised"> {
  const prepared = await deps.prepare({ sb: input.sb,
    clientId: input.clientId, projectId: input.projectId,
    maxAlignmentLoss: input.maxAlignmentLoss });
  if (prepared.irVersion !== input.irVersion
    || prepared.ir.aspects[0] !== input.aspect) {
    throw new PreRenderReviewHeldError(
      "Pre-render critic source differs from the exact first aspect.");
  }
  const brand = await input.sb.from("client_brand_profiles")
    .select("colour_primary,colour_secondary,colour_accent,colour_background,colour_text,font_heading,font_body,imagery_style,never_do")
    .eq("client_id", input.clientId).maybeSingle();
  if (brand.error || !brand.data) {
    throw new PreRenderReviewHeldError(
      "Client brand rules are required before pre-render review.");
  }
  const model = process.env.VIDEO_RENDER_REVIEW_MODEL?.trim()
    || input.config.model;
  const apiKey = anthropicKeyForAgent(input.config, "video_render");
  if (!model || !apiKey) {
    throw new PreRenderReviewHeldError(
      "Pre-render critic model or managed credential is unavailable.");
  }
  const claim = await input.sb.rpc("claim_video_project_prerender_v1", {
    p_project_id: input.projectId, p_job_id: input.jobId,
    p_ir_version: input.irVersion });
  const claimed = claim.data as { state?: string; attempt_id?: string } | null;
  if (claim.error || !claimed?.attempt_id) {
    throw new PreRenderReviewHeldError(
      "Pre-render critic claim is unavailable for this exact project.");
  }
  if (claimed.state === "decided_pass") return "pass";
  if (claimed.state === "decided_fail") {
    const previous = await input.sb.from("video_project_prerender_attempts_v1")
      .select("id,client_id,project_id,ir_version,job_id,state,result,report")
      .eq("id", claimed.attempt_id).eq("client_id", input.clientId)
      .maybeSingle();
    const row = previous.data as { id: string; client_id: string;
      project_id: string; ir_version: number; job_id: string;
      state: string; result: string; report: PreRenderCriticReport } | null;
    if (previous.error || !row || row.id !== claimed.attempt_id
      || row.project_id !== input.projectId
      || row.ir_version !== input.irVersion || row.job_id !== input.jobId
      || row.state !== "decided" || row.result !== "fail"
      || row.report?.result !== "fail") {
      throw new PreRenderReviewHeldError(
        "Prior failed pre-render receipt is unavailable or changed.");
    }
    return continueFailedReview({ sb: input.sb,
      attemptId: claimed.attempt_id, jobId: input.jobId,
      irVersion: input.irVersion, ir: prepared.ir, report: row.report });
  }
  if (claimed.state !== "claimed") {
    throw new PreRenderReviewHeldError(
      `Pre-render attempt is ${claimed.state ?? "unknown"}; reconcile before another paid call.`);
  }
  let decided = false;
  let report: PreRenderCriticReport;
  try {
    const frames = await deps.stills({ region: input.region,
      functionName: input.functionName, serveUrl: input.serveUrl,
      aspect: input.aspect, ir: prepared.ir, timings: prepared.timings,
      projectId: input.projectId, irVersion: input.irVersion,
      attemptId: claimed.attempt_id });
    report = await deps.review({ frames, ir: prepared.ir,
      brandRules: brandRules(brand.data as Record<string, unknown>),
      model, apiKey });
    if (report.result === "fail" && report.patch.length > 0) {
      try { applyCriticPatch(prepared.ir, report.patch); }
      catch (error) {
        // Preserve the model proposal for an operator, while preventing an
        // invalid patch from entering the automatic revision path.
        const reason = error instanceof Error ? error.message : "Invalid patch";
        Object.assign(report, { raw_patch: report.patch,
          patch_error: reason.slice(0, 500), patch: [] });
      }
    }
    const receipts = frames.map((frame) => ({ sceneId: frame.sceneId,
      frame: frame.frame, renderId: frame.renderId,
      costUsd: frame.costUsd }));
    const stillUsd = Math.round(frames.reduce((sum, frame) =>
      sum + frame.costUsd, 0) * 1_000_000) / 1_000_000;
    const finished = await input.sb.rpc("finish_video_project_prerender_v1", {
      p_attempt_id: claimed.attempt_id, p_job_id: input.jobId,
      p_report: report, p_still_receipts: receipts,
      p_model: report.model, p_input_tokens: report.usage.inputTokens,
      p_output_tokens: report.usage.outputTokens,
      p_model_usd: report.usage.costUsd, p_still_usd: stillUsd });
    if (finished.error || finished.data !== report.result) {
      throw new Error("Pre-render report and cost could not be committed together.");
    }
    decided = true;
  } catch {
    if (!decided) await input.sb.rpc("mark_video_project_prerender_uncertain_v1", {
      p_attempt_id: claimed.attempt_id, p_job_id: input.jobId });
    throw new PreRenderReviewHeldError(
      "Pre-render paid outcome is uncertain; reconcile the attempt before retrying.");
  }
  if (report.result === "pass") return "pass";
  return continueFailedReview({ sb: input.sb,
    attemptId: claimed.attempt_id, jobId: input.jobId,
    irVersion: input.irVersion, ir: prepared.ir, report });
}
