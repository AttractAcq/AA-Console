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
// submitted and polled through the Higgsfield adapter. Pending and Zoom In
// are stored as the Cockpit Zoom In catalog id. Any other name is not
// invented into a UUID, and a missing still is not sent.
// A completed poll copies the clip into client-media and sets clip_path.
// Nothing here sets agents.paused: that would stop the agent for every client.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { isPhase1FormatCode, parseStoredShotPlan, serializeShot, type ShotPlanEntry } from "../brief/shots.js";
import { assemblyHandoff } from "./assembly.js";
import { ClipStoreError, persistCompletedClip } from "./clip.js";
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
  clip_path: string | null;
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

function motionOf(line: string | undefined): string {
  if (!line) return "";
  try {
    const raw = JSON.parse(line) as { motion_preset?: unknown };
    return typeof raw.motion_preset === "string" ? raw.motion_preset.trim() : "";
  } catch {
    return "";
  }
}

/** Lines to write when a stored preset resolved to a catalog id. Null if nothing changed. */
function resolvedPlanLines(stored: readonly string[], shots: readonly ShotPlanEntry[]): string[] | null {
  const next = shots.map(serializeShot);
  const changed = next.some((line, i) => motionOf(line) !== motionOf(stored[i]));
  return changed ? next : null;
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

/**
 * The shots of the newest stills build, and only those.
 *
 * A brief can be built more than once — a rebuild after a rejection, or a
 * re-render because the first set came out the wrong shape. Each build files
 * its own asset against the same brief, each with positions 1..n, so reading
 * every asset's frames returns the same position several times over.
 *
 * That was not a display problem. Every frame became a motion ref, so a brief
 * built three times submitted three clips per shot to Higgsfield: triple the
 * cost, and two thirds of them stills that had already been superseded. A
 * rebuild supersedes, so the newest asset is the one that gets animated.
 */
async function framesForBrief(sb: SupabaseClient, briefId: string): Promise<FrameRow[]> {
  const { data: assets, error } = await sb
    .from("client_media_assets")
    .select("id")
    .eq("brief_id", briefId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`Could not load stills: ${error.message}`);
  const newest = ((assets ?? []) as { id: string }[])[0];
  if (!newest) return [];
  const { data, error: frameError } = await sb
    .from("client_media_frames")
    .select("id, position, storage_path, provider_job_id, clip_path")
    .eq("asset_id", newest.id);
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
  const resolvedLines = resolvedPlanLines(brief.frame_plan ?? [], plan.shots);
  let planSaved: boolean | null = null;
  if (resolvedLines) {
    planSaved = false;
    try {
      const { error: saveError } = await sb.from("client_briefs").update({ frame_plan: resolvedLines }).eq("id", brief.id);
      if (saveError) {
        await appendEvent(
          sb,
          job.id,
          `Shot motions resolved to catalog ids but the plan could not be saved (${saveError.message}).`,
          "warn",
          { stage: "plan", plan_saved: false },
        );
      } else {
        planSaved = true;
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      await appendEvent(sb, job.id, `Shot motions resolved to catalog ids but the plan could not be saved (${message}).`, "warn", {
        stage: "plan",
        plan_saved: false,
      });
    }
  }
  await appendEvent(sb, job.id, `Planned ${plan.shots.length} generated shots for "${title}".`, "info", {
    stage: "plan",
    shot_count: plan.shots.length,
    format_code: brief.format_code,
    shot_source_kind: "ai_generated",
    motion_presets: plan.shots.map((shot) => shot.motion_preset),
    plan_saved: planSaved,
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
  const submitted: Array<{
    position: number;
    requestId: string;
    status: string;
    videoUrl: string | null;
    clipPath: string | null;
  }> = [];
  try {
    for (const call of prepared.calls) {
      if (call.kind === "poll") {
        const polled = await client.pollStatus(call.requestId);
        const clipPath = await persistCompletedClip(sb, {
          clientId: job.client_id,
          frameId: call.frameId,
          status: polled.status,
          videoUrl: polled.videoUrl,
          existingClipPath: frames.find((frame) => frame.id === call.frameId)?.clip_path,
          fetchImpl: globalThis.fetch,
        });
        statuses.push(polled.status);
        submitted.push({
          position: call.position,
          requestId: polled.requestId,
          status: polled.status,
          videoUrl: polled.videoUrl,
          clipPath,
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
      const clipPath = await persistCompletedClip(sb, {
        clientId: job.client_id,
        frameId: call.frameId,
        status: polled.status,
        videoUrl: polled.videoUrl,
        existingClipPath: frames.find((frame) => frame.id === call.frameId)?.clip_path,
        fetchImpl: globalThis.fetch,
      });
      statuses.push(polled.status);
      submitted.push({
        position: call.position,
        requestId: accepted.requestId,
        status: polled.status,
        videoUrl: polled.videoUrl,
        clipPath,
      });
    }
  } catch (caught) {
    const known = caught instanceof HiggsfieldError || caught instanceof ClipStoreError;
    const retryable = caught instanceof HiggsfieldError || caught instanceof ClipStoreError ? caught.retryable : true;
    const message = known && caught instanceof Error ? caught.message : "Higgsfield could not be reached.";
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
  const level = followUp.outcome === "failed" ? "warn" : "info";
  await appendEvent(sb, job.id, followUp.message, level, {
    creative_stage: "motion",
    status: followUp.outcome === "completed" ? "completed" : followUp.outcome,
    job_outcome: followUp.outcome,
    reason: followUp.outcome === "completed" ? "completed" : "higgsfield_" + followUp.outcome,
    provider: "higgsfield",
    higgsfield_called: true,
    shots: submitted,
    assembly: assemblyHandoff(),
  });

  if (followUp.outcome === "failed") return failed(followUp.message, followUp.retryable);

  if (followUp.outcome === "pending") {
    // Not a failure and not a retry: the clips are rendering and already
    // paid for, so this schedules the collection rather than spending an
    // attempt on waiting. Without it the attempts ran out mid-render and
    // six finished clips had nothing left that would ever fetch them.
    const { error: scheduleError } = await sb.rpc("schedule_agent_follow_up", {
      p_agent_key: "video_build",
      p_client_id: job.client_id,
      p_input_table: "client_briefs",
      p_input_id: brief.id,
      p_after_seconds: followUp.pollAfterSeconds,
      p_description: "Scheduled: collect the Higgsfield clips",
    });
    if (scheduleError) {
      // Nothing will collect them if this did not land, so say so loudly and
      // let the retry budget do what it can.
      const message =
        `Higgsfield is still rendering, and the follow-up could not be scheduled ` +
        `(${scheduleError.message}). The request ids are stored on the shots.`;
      await appendEvent(sb, job.id, message, "error", { creative_stage: "motion", reason: "follow_up_unscheduled" });
      return failed(message, true);
    }
    return { ok: true, retryable: false };
  }

  return { ok: true, retryable: false };
}
