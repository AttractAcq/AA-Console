// Video build. A reel brief becomes a shot plan, then stills, then motion.
//
// Phase 1 is F6 and F7 only: generated shots, no client assets. Opening
// stills are an image generation on creative_build — creative_generations
// rejects media_type video, so the stills row stays image-typed. This agent
// does not call an image model.
//
// Motion pauses when HIGGSFIELD_API_KEY, HIGGSFIELD_API_SECRET,
// HIGGSFIELD_MODEL_DRAFT or HIGGSFIELD_MODEL_FINAL is missing. When all four
// are set, shots that have an https still and a catalog motion id are
// submitted and polled through the Higgsfield adapter. A pending motion
// preset is not invented into a UUID, and a missing still is not sent.
// Nothing here sets agents.paused: that would stop the agent for every client.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { isPhase1FormatCode, parseStoredShotPlan } from "../brief/shots.js";
import { assemblyHandoff } from "./assembly.js";
import { createHiggsfieldClient, HiggsfieldError } from "./higgsfield.js";
import {
  decideMotion,
  motionFollowUp,
  prepareMotionCalls,
  readHiggsfieldEnv,
  type MotionFrameRef,
} from "./motion.js";

const MEDIA_BUCKET = "client-media";

interface ReelBrief {
  id: string;
  client_id: string;
  title: string | null;
  media_type: string | null;
  content_format: string | null;
  format_code: string | null;
  frame_plan: string[] | null;
}

interface FrameRow {
  id: string;
  position: number;
  storage_path: string | null;
  provider_job_id: string | null;
}

function failed(failureMessage: string, retryable = false): JobResult {
  return { ok: false, retryable, failureMessage };
}

function isReelWork(brief: ReelBrief): boolean {
  return brief.content_format === "reel" || isPhase1FormatCode(brief.format_code);
}

async function stillsOnFile(
  sb: SupabaseClient,
  briefId: string,
): Promise<{ count: number; error: string | null }> {
  const { data, error } = await sb.from("client_media_assets").select("id").eq("brief_id", briefId);
  if (error) return { count: 0, error: error.message };
  return { count: Array.isArray(data) ? data.length : 0, error: null };
}

function stillsMessage(stills: { count: number; error: string | null }): string {
  if (stills.error) {
    return `Could not check stills (${stills.error}). Opening frames are an image build on creative_build. This agent does not render them.`;
  }
  if (stills.count > 0) {
    return `${stills.count} asset(s) already on this brief. Stills stay on creative_build. This agent does not render another set.`;
  }
  return "No stills on file yet. Opening frames are queued as an image build on creative_build. This agent does not render them.";
}

async function framesForBrief(sb: SupabaseClient, briefId: string): Promise<FrameRow[]> {
  const { data: assets, error } = await sb.from("client_media_assets").select("id").eq("brief_id", briefId);
  if (error) throw new Error(`Could not load stills: ${error.message}`);
  const ids = ((assets ?? []) as { id: string }[]).map((asset) => asset.id);
  if (ids.length === 0) return [];
  const { data, error: frameError } = await sb
    .from("client_media_frames")
    .select("id, position, storage_path, provider_job_id")
    .in("asset_id", ids);
  if (frameError) throw new Error(`Could not load shot frames: ${frameError.message}`);
  return (data ?? []) as FrameRow[];
}

async function signedStillUrls(
  sb: SupabaseClient,
  frames: readonly FrameRow[],
): Promise<Map<number, string>> {
  const urls = new Map<number, string>();
  for (const frame of frames) {
    const path = frame.storage_path?.trim();
    if (!path) continue;
    const { data, error } = await sb.storage.from(MEDIA_BUCKET).createSignedUrl(path, 60 * 60);
    const signed = data?.signedUrl?.trim() ?? "";
    if (error || !signed.startsWith("https://")) continue;
    urls.set(frame.position, signed);
  }
  return urls;
}

export async function runVideoBuildJob(
  sb: SupabaseClient,
  _runtime: RuntimeConfig,
  _agent: AgentRow,
  job: AgentJobRow,
): Promise<JobResult> {
  if (!job.client_id) return failed("Video build jobs require a client.");
  if (job.input_table !== "client_briefs" || !job.input_id) {
    return failed("Video build needs a brief.");
  }

  const { data, error } = await sb
    .from("client_briefs")
    .select("id, client_id, title, media_type, content_format, format_code, frame_plan")
    .eq("id", job.input_id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load brief: ${error.message}`);
  if (!data) return failed("That brief no longer exists.");

  const brief = data as ReelBrief;
  if (brief.client_id !== job.client_id) return failed("That brief belongs to a different client.");
  if (!isReelWork(brief)) {
    return failed("Video build runs on a reel brief (F6 or F7). This brief is not one.");
  }
  if (brief.media_type && brief.media_type !== "video") {
    return failed("A reel is a video. This brief is not.");
  }

  const plan = parseStoredShotPlan(brief.frame_plan);
  if (plan.problem) return failed(plan.problem);

  const title = brief.title?.trim() || "this reel";
  await appendEvent(sb, job.id, `Planned ${plan.shots.length} generated shots for "${title}".`, "info", {
    stage: "plan",
    shot_count: plan.shots.length,
    format_code: brief.format_code,
    shot_source_kind: "ai_generated",
  });

  let stills: { count: number; error: string | null };
  try {
    stills = await stillsOnFile(sb, brief.id);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    stills = { count: 0, error: message };
  }
  await appendEvent(sb, job.id, stillsMessage(stills), "info", {
    stage: "stills",
    ready: stills.count > 0 && !stills.error,
    owner: "creative_build",
  });

  const env = readHiggsfieldEnv();
  const decision = decideMotion(env);
  if (!decision.proceed) {
    await appendEvent(sb, job.id, decision.message, "warn", {
      creative_stage: "motion",
      status: decision.stage,
      job_outcome: "failed",
      reason: decision.reason,
      provider: "higgsfield",
      higgsfield_called: false,
      assembly: assemblyHandoff(),
    });
    return failed(decision.message);
  }

  if (stills.error) {
    const message = `Motion paused: opening stills could not be read (${stills.error}). No Higgsfield request was sent.`;
    await appendEvent(sb, job.id, message, "warn", {
      creative_stage: "motion",
      status: "paused",
      job_outcome: "failed",
      reason: "stills_not_ready",
      provider: "higgsfield",
      higgsfield_called: false,
      assembly: assemblyHandoff(),
    });
    return failed(message);
  }

  let frames: FrameRow[] = [];
  try {
    frames = await framesForBrief(sb, brief.id);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    const paused = `Motion paused: ${message} No Higgsfield request was sent.`;
    await appendEvent(sb, job.id, paused, "warn", {
      creative_stage: "motion",
      status: "paused",
      job_outcome: "failed",
      reason: "stills_not_ready",
      provider: "higgsfield",
      higgsfield_called: false,
      assembly: assemblyHandoff(),
    });
    return failed(paused);
  }

  let stillUrls = new Map<number, string>();
  try {
    stillUrls = await signedStillUrls(sb, frames);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    const paused = `Motion paused: opening stills could not be signed (${message}). No Higgsfield request was sent.`;
    await appendEvent(sb, job.id, paused, "warn", {
      creative_stage: "motion",
      status: "paused",
      job_outcome: "failed",
      reason: "stills_not_ready",
      provider: "higgsfield",
      higgsfield_called: false,
      assembly: assemblyHandoff(),
    });
    return failed(paused);
  }

  const frameRefs: MotionFrameRef[] = frames.map((frame) => ({
    id: frame.id,
    position: frame.position,
    providerJobId: frame.provider_job_id,
  }));
  const prepared = prepareMotionCalls({
    shots: plan.shots,
    frames: frameRefs,
    stillUrlByPosition: stillUrls,
    modelId: decision.modelDraft,
  });
  if (!prepared.ok) {
    await appendEvent(sb, job.id, prepared.message, "warn", {
      creative_stage: "motion",
      status: "paused",
      job_outcome: "failed",
      reason: prepared.reason,
      provider: "higgsfield",
      higgsfield_called: false,
      assembly: assemblyHandoff(),
    });
    return failed(prepared.message);
  }

  const client = createHiggsfieldClient(
    { apiKey: env.apiKey ?? "", apiSecret: env.apiSecret ?? "" },
    globalThis.fetch,
  );
  const statuses: string[] = [];
  const submitted: Array<{ position: number; requestId: string; status: string; videoUrl: string | null }> = [];
  try {
    for (const call of prepared.calls) {
      if (call.kind === "poll") {
        const polled = await client.pollStatus(call.requestId);
        statuses.push(polled.status);
        submitted.push({
          position: call.position,
          requestId: polled.requestId,
          status: polled.status,
          videoUrl: polled.videoUrl,
        });
        continue;
      }
      const accepted = await client.submitI2V({
        modelId: call.modelId,
        prompt: call.prompt,
        imageUrl: call.imageUrl,
        motions: [{ id: call.motionId, strength: call.strength }],
      });
      const { error: saveError } = await sb
        .from("client_media_frames")
        .update({ provider_job_id: accepted.requestId })
        .eq("id", call.frameId);
      if (saveError) {
        const message = `Higgsfield accepted shot ${call.position} (${accepted.requestId}) but the request id was not stored. It was not submitted again.`;
        await appendEvent(sb, job.id, message, "warn", {
          creative_stage: "motion",
          status: "paused",
          job_outcome: "failed",
          reason: "provider_job_not_stored",
          provider: "higgsfield",
          higgsfield_called: true,
          request_id: accepted.requestId,
          assembly: assemblyHandoff(),
        });
        return failed(message);
      }
      const polled = await client.pollStatus(accepted.requestId);
      statuses.push(polled.status);
      submitted.push({
        position: call.position,
        requestId: accepted.requestId,
        status: polled.status,
        videoUrl: polled.videoUrl,
      });
    }
  } catch (caught) {
    const retryable = caught instanceof HiggsfieldError ? caught.retryable : true;
    const message = caught instanceof HiggsfieldError ? caught.message : "Higgsfield could not be reached.";
    await appendEvent(sb, job.id, message, "warn", {
      creative_stage: "motion",
      status: "paused",
      job_outcome: "failed",
      reason: "higgsfield_error",
      provider: "higgsfield",
      higgsfield_called: true,
      assembly: assemblyHandoff(),
    });
    return failed(message, retryable);
  }

  const followUp = motionFollowUp(statuses);
  await appendEvent(sb, job.id, followUp.message, followUp.ok ? "info" : "warn", {
    creative_stage: "motion",
    status: followUp.ok ? "completed" : "paused",
    job_outcome: followUp.ok ? "completed" : "failed",
    reason: followUp.ok ? "completed" : "higgsfield_pending",
    provider: "higgsfield",
    higgsfield_called: true,
    shots: submitted,
    assembly: assemblyHandoff(),
  });
  if (!followUp.ok) return failed(followUp.message, followUp.retryable);
  return { ok: true, retryable: false };
}
