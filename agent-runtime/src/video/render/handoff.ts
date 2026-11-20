import type { SupabaseClient } from "@supabase/supabase-js";
import type { AwsRegion } from "@remotion/lambda";
import { buildVideoRenderInputs } from "./inputs.js";
import { LambdaRenderObservationError, LambdaRenderStartUnknownError,
  resumeLambdaRender, startLambdaRender,
  type LambdaRenderHandle } from "./lambda.js";
import { masterProjectRender } from "./master.js";
import { probeProjectRender, type ProjectRenderProbe } from "./probe.js";

type Attempt = { id: string; project_id: string; client_id: string;
  ir_version: number; aspect: string; job_id: string; state: string;
  region: string | null; function_name: string | null;
  render_id: string | null; bucket_name: string | null;
  out_name: string | null; serve_url: string | null };
type Dependencies = { prepare: typeof buildVideoRenderInputs;
  start: typeof startLambdaRender; resume: typeof resumeLambdaRender;
  master: typeof masterProjectRender; probe: typeof probeProjectRender };
const dependencies: Dependencies = { prepare: buildVideoRenderInputs,
  start: startLambdaRender, resume: resumeLambdaRender,
  master: masterProjectRender, probe: probeProjectRender };

export class VideoRenderUncertainError extends Error {
  constructor(readonly attemptId: string, reason: string) {
    super(`Video render attempt ${attemptId} needs reconciliation: ${reason}`);
  }
}

export type LambdaCostEstimate = { billingMs: number;
  estimatedUsd: number; currency: "USD" };

function finalEstimate(progress: Awaited<ReturnType<typeof resumeLambdaRender>>["progress"]): LambdaCostEstimate {
  const billingMs = progress.estimatedBillingDurationInMilliseconds;
  const usd = progress.costs?.accruedSoFar;
  if (progress.done !== true || typeof billingMs !== "number"
    || !Number.isSafeInteger(billingMs)
    || billingMs <= 0 || billingMs > 9_999_999_999
    || typeof usd !== "number" || !Number.isFinite(usd)
    || usd < 0 || usd > 10_000
    || progress.costs.currency !== "USD") {
    throw new Error("Lambda final USD billing estimate is unavailable; reconcile before candidate filing.");
  }
  return { billingMs, estimatedUsd: Math.round(usd * 1_000_000) / 1_000_000,
    currency: "USD" };
}

function attemptHandle(attempt: Attempt): LambdaRenderHandle {
  if (!attempt.region || !attempt.function_name || !attempt.render_id
    || !attempt.bucket_name || !attempt.out_name || !attempt.serve_url) {
    throw new VideoRenderUncertainError(attempt.id,
      "a started attempt has no complete provider handle");
  }
  return { region: attempt.region as AwsRegion,
    functionName: attempt.function_name, renderId: attempt.render_id,
    bucketName: attempt.bucket_name, outName: attempt.out_name,
    serveUrl: attempt.serve_url };
}

/** Bind one aspect to a preflighted IR and one durable Lambda attempt.
 * A duplicate claim never calls Lambda again. The mastered, probed local MP4
 * still needs its exact Storage receipt and human review before attachment.
 */
export async function renderProjectAspect(input: {
  sb: SupabaseClient; clientId: string; projectId: string;
  jobId: string; irVersion: number;
  aspect: "16:9" | "9:16" | "1:1";
  region: AwsRegion; functionName: string; serveUrl: string;
  localPath: string; maxAlignmentLoss: number;
  observationDeadlineMs?: number;
}, deps: Dependencies = dependencies): Promise<{
  attemptId: string; handle: LambdaRenderHandle;
  outputPath: string; sizeInBytes: number; probe: ProjectRenderProbe;
  providerEstimate: LambdaCostEstimate;
}> {
  if (!input.localPath.endsWith(".mp4")) {
    throw new Error("Render download path must end in .mp4.");
  }
  const prepared = await deps.prepare({ sb: input.sb,
    clientId: input.clientId, projectId: input.projectId,
    maxAlignmentLoss: input.maxAlignmentLoss });
  if (prepared.irVersion !== input.irVersion
    || !prepared.ir.aspects.includes(input.aspect)) {
    throw new Error("Render job differs from the current IR or requested aspect.");
  }
  const claim = await input.sb.rpc("claim_video_project_render_v1", {
    p_project_id: input.projectId, p_job_id: input.jobId,
    p_ir_version: input.irVersion, p_aspect: input.aspect,
  });
  if (claim.error || !claim.data
    || typeof claim.data.attempt_id !== "string"
    || typeof claim.data.state !== "string") {
    throw new Error("Render claim could not be bound to the exact job.");
  }
  const attemptId = claim.data.attempt_id as string;
  const state = claim.data.state as string;
  let handle: LambdaRenderHandle;
  if (state === "claimed") {
    try {
      handle = await deps.start({ region: input.region,
        functionName: input.functionName, serveUrl: input.serveUrl,
        projectId: input.projectId, aspect: input.aspect,
        ir: prepared.ir, timings: prepared.timings,
        onStarted: async (started) => {
          const filed = await input.sb.rpc("record_video_project_lambda_handle_v2", {
            p_attempt_id: attemptId, p_job_id: input.jobId,
            p_region: started.region, p_function_name: started.functionName,
            p_render_id: started.renderId, p_bucket_name: started.bucketName,
            p_out_name: started.outName, p_serve_url: started.serveUrl,
          });
          if (filed.error || filed.data !== true) {
            throw new Error("Lambda handle was not durably recorded.");
          }
        } });
    } catch (error) {
      if (error instanceof LambdaRenderStartUnknownError
        || error instanceof LambdaRenderObservationError) {
        await input.sb.rpc("mark_video_project_render_uncertain_v1", {
          p_attempt_id: attemptId, p_job_id: input.jobId,
          p_code: "start_unknown",
        });
        throw new VideoRenderUncertainError(attemptId,
          "the provider start or handle write was uncertain");
      }
      throw error;
    }
  } else if (state === "already_started") {
    const loaded = await input.sb.from("video_project_render_attempts_v1")
      .select("id,project_id,client_id,ir_version,aspect,job_id,state,region,function_name,render_id,bucket_name,out_name,serve_url")
      .eq("id", attemptId).eq("client_id", input.clientId).maybeSingle();
    const attempt = loaded.data as Attempt | null;
    if (loaded.error || !attempt || attempt.id !== attemptId
      || attempt.project_id !== input.projectId
      || attempt.ir_version !== input.irVersion
      || attempt.aspect !== input.aspect || attempt.job_id !== input.jobId
      || attempt.state !== "started") {
      throw new VideoRenderUncertainError(attemptId,
        "the stored provider handle does not match this job");
    }
    handle = attemptHandle(attempt);
    if (handle.region !== input.region
      || handle.functionName !== input.functionName
      || handle.serveUrl !== input.serveUrl
      || handle.outName !== `${input.projectId}-${input.aspect.replace(":", "x")}.mp4`) {
      throw new VideoRenderUncertainError(attemptId,
        "the deployment identity changed since the provider start");
    }
  } else {
    if (state === "already_claimed") {
      await input.sb.rpc("mark_video_project_render_uncertain_v1", {
        p_attempt_id: attemptId, p_job_id: input.jobId,
        p_code: "claim_without_handle",
      });
    }
    throw new VideoRenderUncertainError(attemptId,
      `existing attempt state ${state} cannot start again`);
  }
  const downloaded = await deps.resume({ handle, localPath: input.localPath,
    ...(input.observationDeadlineMs === undefined ? {}
      : { deadlineMs: input.observationDeadlineMs }) });
  const mastered = await deps.master({ sourcePath: downloaded.outputPath,
    outputPath: downloaded.outputPath.replace(/\.mp4$/, "-master.mp4") });
  const probe = await deps.probe({ path: mastered.outputPath,
    aspect: input.aspect });
  return { attemptId, handle, outputPath: mastered.outputPath,
    sizeInBytes: mastered.fileBytes, probe,
    providerEstimate: finalEstimate(downloaded.progress) };
}
