import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { anthropicVideoCompletion, VideoStoryboardValidationError,
  writeVideoStoryboard, type VideoCompletion, type VideoSource } from "../../video/storyboard.js";
import { reviewVideoStoryboard, VideoReviewValidationError,
  VIDEO_REVIEW_SYSTEM } from "../../video/review.js";

type Project = {
  id: string; client_id: string; stage: string; job_id: string | null;
  idea: string; audience: string | null; tone: "calm" | "confident" | "energetic";
  target_length_sec: number; aspects: string[]; ir_version: number;
  source_snapshot: unknown; source_digest: string | null; ir: unknown;
  script: unknown;
};

function snapshotSources(value: unknown): VideoSource[] {
  if (!Array.isArray(value)) throw new Error("Video source snapshot is not an array.");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Video source snapshot contains an invalid entry.");
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.kind !== "string"
      || typeof row.asOf !== "string" || typeof row.text !== "string") {
      throw new Error("Video source snapshot is incomplete.");
    }
    return { id: row.id, kind: row.kind as VideoSource["kind"],
      asOf: row.asOf, text: row.text };
  });
}

async function sourceCurrent(sb: SupabaseClient, projectId: string): Promise<boolean> {
  const { data, error } = await sb.rpc("video_project_source_current_v1",
    { p_project_id: projectId });
  if (error) throw new Error(`Video source preflight failed: ${error.message}`);
  return data === true;
}

async function accountAttempt(sb: SupabaseClient, projectId: string,
  job: AgentJobRow, pass: "writer" | "reviewer",
  usage: { inputTokens: number; outputTokens: number; costUsd: number }): Promise<void> {
  if (usage.inputTokens + usage.outputTokens === 0 && usage.costUsd === 0) return;
  const { error } = await sb.rpc("record_video_project_cost_v1", {
    p_project_id: projectId, p_job_id: job.id,
    p_attempt_key: `${job.id}:${pass}:${job.attempts}`,
    p_provider: "anthropic", p_units: usage.inputTokens + usage.outputTokens,
    p_usd: usage.costUsd,
  });
  if (error) throw new Error(`Video cost receipt failed: ${error.message}`);
}

async function setNeedsHuman(sb: SupabaseClient, project: Project,
  job: AgentJobRow, reason: string): Promise<void> {
  const { error } = await sb.from("video_projects").update({ stage: "needs_human",
    stage_error: reason.slice(0, 1000) })
    .eq("id", project.id).eq("client_id", project.client_id)
    .eq("job_id", job.id).in("stage", ["queued", "scripting"]);
  if (error) throw new Error("Video project could not enter human review.");
}

export async function runVideoScriptJobWithCompletion(
  sb: SupabaseClient, job: AgentJobRow,
  complete: VideoCompletion, reviewComplete: VideoCompletion, catalogue: string,
): Promise<JobResult> {
  if (job.agent_key !== "video_script" || job.input_table !== "video_projects"
    || !job.input_id || !job.client_id) return { ok: false, retryable: false,
    failureMessage: "Video script job has invalid input identity." };
  const { data, error } = await sb.from("video_projects").select("*")
    .eq("id", job.input_id).eq("client_id", job.client_id).maybeSingle();
  if (error || !data) return { ok: false, retryable: false,
    failureMessage: "Video project is unavailable to the job." };
  const project = data as Project;
  if (project.job_id === job.id && project.stage === "needs_human"
    && project.ir !== null && project.script !== null) {
    return { ok: true, retryable: false };
  }
  if (project.job_id !== job.id
    || project.source_digest !== job.params?.source_digest
    || project.ir_version !== job.params?.ir_version
    || !project.audience || !["queued", "scripting"].includes(project.stage)) {
    return { ok: false, retryable: false,
      failureMessage: "Video project changed since the queued source snapshot." };
  }
  let sources: VideoSource[];
  try { sources = snapshotSources(project.source_snapshot); }
  catch { return { ok: false, retryable: false,
    failureMessage: "Video source snapshot is invalid." }; }
  let incurredUsage: JobResult["usage"];
  try {
    if (!await sourceCurrent(sb, project.id)) {
      await setNeedsHuman(sb, project, job, "Video source or campaign route changed before writing.");
      return { ok: false, retryable: false,
        failureMessage: "Video source or campaign route is no longer current." };
    }
    if (project.stage === "queued") {
      const started = await sb.from("video_projects")
        .update({ stage: "scripting", stage_error: null })
        .eq("id", project.id).eq("client_id", project.client_id)
        .eq("job_id", job.id).eq("stage", "queued")
        .select("id").maybeSingle();
      if (started.error || !started.data) throw new Error("Video project could not enter scripting.");
    }
    await appendEvent(sb, job.id, "Writing a source-bound video storyboard.");
    const storyboard = await writeVideoStoryboard({
      idea: project.idea, audience: project.audience, tone: project.tone,
      targetLengthSec: project.target_length_sec,
      aspects: project.aspects as Array<"16:9" | "9:16" | "1:1">,
      sources, catalogue,
    }, complete);
    incurredUsage = storyboard.usage;
    await accountAttempt(sb, project.id, job, "writer", storyboard.usage);
    if (!await sourceCurrent(sb, project.id)) {
      await setNeedsHuman(sb, project, job, "Video source changed during writing.");
      return { ok: false, retryable: false,
        failureMessage: "Video source changed during writing; output was not stored.",
        usage: storyboard.usage };
    }
    await appendEvent(sb, job.id, "Reviewing the storyboard independently.");
    const review = await reviewVideoStoryboard(storyboard, sources, reviewComplete);
    incurredUsage = { inputTokens: storyboard.usage.inputTokens + review.usage.inputTokens,
      outputTokens: storyboard.usage.outputTokens + review.usage.outputTokens,
      costUsd: storyboard.usage.costUsd + review.usage.costUsd };
    await accountAttempt(sb, project.id, job, "reviewer", review.usage);
    if (!await sourceCurrent(sb, project.id)) {
      await setNeedsHuman(sb, project, job, "Video source or campaign route changed during writing.");
      return { ok: false, retryable: false,
        failureMessage: "Video source changed during writing; output was not stored.",
        usage: incurredUsage };
    }
    const saved = await sb.from("video_projects").update({
      ir: review.ir, ir_version: project.ir_version + 1,
      script: { scene_sources: review.sceneSources,
        source_digest: project.source_digest,
        writer_source_digest: storyboard.sourceDigest,
        unsourced: storyboard.unsourced,
        writer_attempts: storyboard.attempts,
        independent_review: { accepted: review.accepted,
          reasons: review.reasons, edits: review.edits } },
      stage: "needs_human",
      stage_error: review.accepted
        ? "Independent review passed; renderer compile and human claim review pending."
        : `Independent review held: ${review.reasons.join("; ").slice(0, 700)}`,
    }).eq("id", project.id).eq("client_id", project.client_id)
      .eq("job_id", job.id).eq("stage", "scripting")
      .eq("ir_version", project.ir_version).select("id").maybeSingle();
    if (saved.error || !saved.data) throw new Error("Video storyboard version changed before save.");
    await appendEvent(sb, job.id, review.accepted
      ? `Reviewed storyboard stored for renderer and human review (${review.ir.scenes.length} scenes).`
      : "Storyboard held after independent review.");
    return { ok: true, retryable: false, usage: incurredUsage };
  } catch (caught) {
    if (caught instanceof VideoStoryboardValidationError) {
      incurredUsage = caught.usage;
      if (caught.usage) await accountAttempt(sb, project.id, job, "writer", caught.usage);
      await setNeedsHuman(sb, project, job, "Storyboard validation failed; revise the source or prompt.");
      return { ok: false, retryable: false,
        failureMessage: "Video storyboard did not pass validation.", usage: caught.usage };
    }
    if (caught instanceof VideoReviewValidationError) {
      incurredUsage = { inputTokens: (incurredUsage?.inputTokens ?? 0) + caught.usage.inputTokens,
        outputTokens: (incurredUsage?.outputTokens ?? 0) + caught.usage.outputTokens,
        costUsd: (incurredUsage?.costUsd ?? 0) + caught.usage.costUsd };
      await accountAttempt(sb, project.id, job, "reviewer", caught.usage);
      await setNeedsHuman(sb, project, job,
        "Independent review was invalid; an operator must inspect the storyboard.");
      return { ok: false, retryable: false,
        failureMessage: "Independent video review did not pass validation.", usage: incurredUsage };
    }
    const retryable = caught instanceof Anthropic.APIError
      && !incurredUsage && (caught.status === 429 || caught.status >= 500);
    if (!retryable) await setNeedsHuman(sb, project, job,
      "Video writing stopped; an operator must inspect the job.");
    return { ok: false, retryable,
      failureMessage: retryable ? "Video model service is temporarily unavailable."
        : "Video writing failed; inspect the job and source state.",
      usage: incurredUsage };
  }
}

export async function runVideoScriptJob(sb: SupabaseClient, config: RuntimeConfig,
  _agent: AgentRow, job: AgentJobRow): Promise<JobResult> {
  const catalogue = await readFile(new URL("../../video/catalogue.md", import.meta.url), "utf8");
  return runVideoScriptJobWithCompletion(sb, job,
    anthropicVideoCompletion(config),
    anthropicVideoCompletion(config, VIDEO_REVIEW_SYSTEM), catalogue);
}
