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

type Dependencies = { prepare: typeof buildVideoRenderInputs;
  stills: typeof renderPreRenderStills;
  review: typeof reviewPreRenderStills };
const defaults: Dependencies = { prepare: buildVideoRenderInputs,
  stills: renderPreRenderStills, review: reviewPreRenderStills };

export class PreRenderReviewHeldError extends Error {}

/** One exact billable pre-render attempt. A retry may read a decided pass,
 * but a claimed or uncertain attempt never repeats Lambda or the model.
 */
export async function runPreRenderCritic(input: {
  sb: SupabaseClient; config: RuntimeConfig;
  clientId: string; projectId: string; jobId: string;
  irVersion: number; aspect: VideoAspect;
  region: AwsRegion; functionName: string; serveUrl: string;
  maxAlignmentLoss: number;
}, deps: Dependencies = defaults): Promise<"pass" | "fail"> {
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
  if (claimed.state === "decided_fail") return "fail";
  if (claimed.state !== "claimed") {
    throw new PreRenderReviewHeldError(
      `Pre-render attempt is ${claimed.state ?? "unknown"}; reconcile before another paid call.`);
  }
  try {
    const frames = await deps.stills({ region: input.region,
      functionName: input.functionName, serveUrl: input.serveUrl,
      aspect: input.aspect, ir: prepared.ir, timings: prepared.timings,
      projectId: input.projectId, irVersion: input.irVersion,
      attemptId: claimed.attempt_id });
    const report = await deps.review({ frames, ir: prepared.ir,
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
    return report.result;
  } catch {
    await input.sb.rpc("mark_video_project_prerender_uncertain_v1", {
      p_attempt_id: claimed.attempt_id, p_job_id: input.jobId });
    throw new PreRenderReviewHeldError(
      "Pre-render paid outcome is uncertain; reconcile the attempt before retrying.");
  }
}
