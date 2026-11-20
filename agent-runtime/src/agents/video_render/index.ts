import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AwsRegion } from "@remotion/lambda";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { VideoRenderUncertainError } from "../../video/render/handoff.js";
import { LambdaRenderObservationError } from "../../video/render/lambda.js";
import { renderAndFileProjectAspect } from "../../video/render/pipeline.js";
import { runPreRenderCritic, PreRenderReviewHeldError }
  from "../../video/render/prerender.js";
import { finalizeVideoProjectRender, VideoCreativeReviewHeldError }
  from "../../video/render/finalize.js";
import type { VideoAspect } from "../../video/render/probe.js";

type Project = { id: string; client_id: string; stage: string;
  ir_version: number; aspects: VideoAspect[] };
type Pipeline = typeof renderAndFileProjectAspect;
type Finalizer = typeof finalizeVideoProjectRender;
type PreReview = typeof runPreRenderCritic;
const ASPECTS = new Set(["16:9", "9:16", "1:1"]);
const REGION = /^[a-z]{2}(?:-[a-z]+)+-[1-9]$/;

function deployment(config: RuntimeConfig): { region: AwsRegion;
  functionName: string; serveUrl: string } | null {
  const region = config.remotionAwsRegion;
  const functionName = config.remotionFunctionName;
  const serveUrl = config.remotionServeUrl;
  if (!region || !REGION.test(region)
    || !functionName || !/^[A-Za-z0-9_-]{1,64}$/.test(functionName)
    || !serveUrl || !serveUrl.startsWith("https://")) return null;
  try {
    const url = new URL(serveUrl);
    if (!url.hostname || url.username || url.password) return null;
  } catch { return null; }
  return { region: region as AwsRegion, functionName, serveUrl };
}

function exactAspects(value: unknown): value is VideoAspect[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 3
    && value.every((aspect) => typeof aspect === "string" && ASPECTS.has(aspect))
    && new Set(value).size === value.length;
}

/** The registry row remains paused until a reviewed renderer site, AWS
 * credentials, alignment policy and operational test are established.
 */
export async function runVideoRenderJobWithPipeline(
  sb: SupabaseClient, config: RuntimeConfig, agent: AgentRow,
  job: AgentJobRow, deadline: number,
  pipeline: Pipeline = renderAndFileProjectAspect,
  credentialsAvailable: () => boolean = () => Boolean(
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY),
  finalizer: Finalizer = finalizeVideoProjectRender,
  preReview: PreReview = runPreRenderCritic,
): Promise<JobResult> {
  const params = job.params ?? {};
  if (job.agent_key !== "video_render"
    || job.input_table !== "video_projects"
    || !job.input_id || !job.client_id
    || !Number.isInteger(params.ir_version) || Number(params.ir_version) < 1
    || !exactAspects(params.aspects)) {
    return { ok: false, retryable: false,
      failureMessage: "Video render job has an invalid project or aspect identity." };
  }
  const projectResult = await sb.from("video_projects")
    .select("id,client_id,stage,ir_version,aspects")
    .eq("id", job.input_id).eq("client_id", job.client_id).maybeSingle();
  const project = projectResult.data as Project | null;
  if (projectResult.error || !project
    || project.id !== job.input_id || project.client_id !== job.client_id
    || project.ir_version !== params.ir_version
    || !exactAspects(project.aspects)
    || JSON.stringify(project.aspects) !== JSON.stringify(params.aspects)) {
    return { ok: false, retryable: false,
      failureMessage: "Video render job differs from the current timed project." };
  }
  if (project.stage === "attached") {
    const prior = await sb.from("video_project_attachments_v1")
      .select("asset_id").eq("project_id", project.id)
      .eq("client_id", project.client_id)
      .eq("ir_version", project.ir_version).maybeSingle();
    return prior.error || !prior.data?.asset_id
      ? { ok: false, retryable: false,
        failureMessage: "Attached video lacks its exact asset receipt." }
      : { ok: true, retryable: false };
  }
  if (project.stage !== "timed") {
    return { ok: false, retryable: false,
      failureMessage: "Video render job differs from the current timed project." };
  }
  const site = deployment(config);
  const alignmentLoss = agent.config.max_alignment_loss;
  if (!site || !credentialsAvailable()
    || typeof alignmentLoss !== "number" || !Number.isFinite(alignmentLoss)
    || alignmentLoss < 0 || alignmentLoss > 1) {
    return { ok: false, retryable: false, hold: true,
      failureMessage: "Video render deployment, AWS credentials or reviewed alignment policy is unavailable." };
  }
  const directory = await mkdtemp(join(tmpdir(), "aa-video-render-"));
  try {
    const review = await preReview({ sb, config,
      clientId: project.client_id, projectId: project.id,
      jobId: job.id, irVersion: project.ir_version,
      aspect: project.aspects[0]!, region: site.region,
      functionName: site.functionName, serveUrl: site.serveUrl,
      maxAlignmentLoss: alignmentLoss });
    if (review !== "pass") {
      return { ok: false, retryable: false, hold: true,
        failureMessage: "Pre-render critic failed; review its exact report and patch before media rendering." };
    }
    const candidateIds = new Map<VideoAspect, string>();
    for (const aspect of project.aspects) {
      // Leave enough lease time to download, master, probe and file a large
      // video after Lambda observation. The next attempt resumes its handle.
      const observationDeadlineMs = Math.min(45 * 60_000,
        deadline - Date.now() - 60 * 60_000);
      if (observationDeadlineMs < 60_000) {
        return { ok: false, retryable: true,
          failureMessage: "Video render lease window is too short; resume the same attempts." };
      }
      const result = await pipeline({ sb, config,
        clientId: project.client_id, projectId: project.id,
        jobId: job.id, irVersion: project.ir_version, aspect,
        region: site.region, functionName: site.functionName,
        serveUrl: site.serveUrl,
        localPath: join(directory, `${aspect.replace(":", "x")}.mp4`),
        maxAlignmentLoss: alignmentLoss,
        observationDeadlineMs });
      await appendEvent(sb, job.id, "Code-rendered video candidate filed.",
        "info", { project_id: project.id, ir_version: project.ir_version,
          aspect, candidate_id: result.candidateId,
          probe_result: result.probeResult, resumed: result.resumed });
      candidateIds.set(aspect, result.candidateId);
      if (result.probeResult !== "pass") {
        return { ok: false, retryable: false,
          failureMessage: `Video ${aspect} failed its physical media probe; inspect the candidate.` };
      }
    }
    const finalized = await finalizer({ sb, config,
      clientId: project.client_id, projectId: project.id,
      jobId: job.id, irVersion: project.ir_version,
      aspects: project.aspects, candidateIds, workDir: directory,
      maxAlignmentLoss: alignmentLoss });
    if (finalized.state === "rejected") {
      return { ok: false, retryable: false,
        failureMessage: "Video creative review rejected the exact first-aspect candidate." };
    }
    await appendEvent(sb, job.id, "Code-rendered video attached for human review.",
      "info", { project_id: project.id, ir_version: project.ir_version,
        asset_id: finalized.assetId });
    return { ok: true, retryable: false };
  } catch (error) {
    if (error instanceof PreRenderReviewHeldError) {
      return { ok: false, retryable: false, hold: true,
        failureMessage: error.message };
    }
    if (error instanceof VideoCreativeReviewHeldError) {
      return { ok: false, retryable: false, hold: true,
        failureMessage: error.message };
    }
    if (error instanceof VideoRenderUncertainError) {
      return { ok: false, retryable: false,
        failureMessage: "Video Lambda start is uncertain; reconcile the recorded attempt before any retry." };
    }
    if (error instanceof LambdaRenderObservationError) {
      const providerFailed = error.message.startsWith("Lambda render failed;");
      return { ok: false, retryable: !providerFailed,
        failureMessage: providerFailed
          ? "Video Lambda reported a fatal render; inspect its recorded handle and revise."
          : "Video Lambda observation failed; retry will resume the recorded handle." };
    }
    if (error instanceof Error && /source is no longer current|differs from this export|not bound to this render job/.test(error.message)) {
      return { ok: false, retryable: false,
        failureMessage: "Video source or prior candidate changed; review before another render." };
    }
    return { ok: false, retryable: true,
      failureMessage: "Video candidate transfer or filing failed; retry will inspect the exact attempt and Storage object." };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runVideoRenderJob(sb: SupabaseClient,
  config: RuntimeConfig, agent: AgentRow, job: AgentJobRow,
  deadline: number): Promise<JobResult> {
  return runVideoRenderJobWithPipeline(sb, config, agent, job, deadline);
}
