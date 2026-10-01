// Video build. A reel brief becomes a shot plan, then stills, then motion.
//
// Phase 1 is F6 and F7 only: generated shots, no client assets. Stills stay
// on creative_build — a shot's opening frame is an image, which that agent
// already renders. This agent does not call an image model.
//
// Motion pauses when HIGGSFIELD_API_KEY or HIGGSFIELD_API_SECRET is missing,
// and also when both are set, because the HTTP client is not in this
// scaffold. Either way the result is a job event and a non-retryable
// failure. Non-retryable so the worker does not requeue it. The event says
// paused, because the brief is fine and the provider is not ready. Nothing
// here sets agents.paused: that would stop the agent for every client.
//
// creative_generations still rejects media_type video, so this does not
// write a creative_stage row. The motion stage is the job event. The enum
// value is in place for when a generation row can represent the reel.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { isPhase1FormatCode, parseStoredShotPlan } from "../brief/shots.js";
import { assemblyHandoff } from "./assembly.js";
import { decideMotion, readHiggsfieldEnv } from "./motion.js";

interface ReelBrief {
  id: string;
  client_id: string;
  title: string | null;
  media_type: string | null;
  content_format: string | null;
  format_code: string | null;
  frame_plan: string[] | null;
}

function failed(failureMessage: string): JobResult {
  return { ok: false, retryable: false, failureMessage };
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
    return `Could not check stills (${stills.error}). Opening frames stay on creative_build. This agent does not render them.`;
  }
  if (stills.count > 0) {
    return `${stills.count} asset(s) already on this brief. Stills stay on creative_build. This agent does not render another set.`;
  }
  return "No stills on file yet. Opening frames are creative_build's job (OpenAI images). This agent does not render them.";
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

  // A stills lookup that fails must not skip the credential gate, and must
  // not escape as an uncaught retry. There is nothing to render here either way.
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

  const decision = decideMotion(readHiggsfieldEnv());
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
