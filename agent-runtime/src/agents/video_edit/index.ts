// The cut. A reel's clips become one 1080x1920 file.
//
// video_build ends at assembly.ts — "Clips are not composited here" — and
// hands the reel to a person by email. This is the other half: the model
// writes an edit decision list, pure code validates it, ffmpeg renders it.
//
// The model never touches ffmpeg. It submits an EDL through a strict tool
// schema, validateEdl checks it against the clips that actually exist and
// the claims the brief actually makes, and only a validated EDL reaches
// buildRenderPlan. A caption the model invented a statistic for does not
// get rendered and then reviewed; it does not get rendered.
//
// What this does not do: email anybody. A cut that cannot be validated
// twice fails with its findings recorded, and the editor handoff stays a
// person's decision — brief_dispatch sends to a real inbox and Resend is
// not configured. Failing loudly with the reasons is the honest outcome.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { parseEdl, validateEdl, totalDuration, type Edl } from "./edl.js";
import {
  bannedPhrases,
  briefTextForEdit,
  editContext,
  editReadiness,
  maxReelSeconds,
  type BriefForEdit,
  type EditShot,
  type FrameRowForEdit,
} from "./handoff.js";
import { probeDurationSec, render, renderCapability, sampleFrames } from "./media.js";
import { installFont } from "./font.js";
import { planEdit, type PlanClip } from "./plan.js";
import { buildRenderPlan } from "./render.js";

const BUCKET = "client-media";
/** Enough to read the cut without paying for every frame of it. */
const SAMPLE_FPS = 1;
const SAMPLE_WIDTH = 384;

const failed = (failureMessage: string, retryable = false): JobResult => ({
  ok: false,
  retryable,
  failureMessage,
});

export function renderStoragePath(clientId: string, assetId: string): string {
  return `${clientId}/reels/${assetId}/cut.mp4`;
}

interface AssetRow {
  id: string;
  client_id: string;
  brief_id: string | null;
  title: string | null;
  media_type: string | null;
  content_format: string | null;
}

export async function runVideoEditJob(
  sb: SupabaseClient,
  config: RuntimeConfig,
  _agent: AgentRow,
  job: AgentJobRow,
  deadlineMs?: number,
): Promise<JobResult> {
  if (!job.client_id) return failed("A cut needs a client.");
  if (job.input_table !== "client_media_assets" || !job.input_id) {
    return failed("A cut needs the reel asset to cut.");
  }

  const { data: assetRow, error: assetError } = await sb
    .from("client_media_assets")
    .select("id, client_id, brief_id, title, media_type, content_format")
    .eq("id", job.input_id)
    .maybeSingle();
  if (assetError) return failed(`Could not load the reel: ${assetError.message}`, true);
  const asset = assetRow as AssetRow | null;
  if (!asset) return failed("That reel no longer exists.");
  if (asset.content_format !== "reel" || asset.media_type !== "video") {
    return failed("Only a reel is cut here.");
  }
  if (!asset.brief_id) return failed("That reel has no brief, so there is nothing to cut it against.");

  const { data: briefRow, error: briefError } = await sb
    .from("client_briefs")
    .select(
      "id, title, media_type, content_format, format_code, frame_plan, hook, script, call_to_action, proof, channel_intent",
    )
    .eq("id", asset.brief_id)
    .maybeSingle();
  if (briefError) return failed(`Could not load the brief: ${briefError.message}`, true);
  const brief = briefRow as BriefForEdit | null;
  if (!brief) return failed("That reel's brief no longer exists.");

  const { data: frameRows, error: frameError } = await sb
    .from("client_media_frames")
    .select("id, position, beat, duration_sec, shot_source_kind, clip_path, provider_job_id")
    .eq("asset_id", asset.id)
    .order("position");
  if (frameError) return failed(`Could not load the shots: ${frameError.message}`, true);

  // The gate. Today this is where every run stops: motion is paused until
  // the Higgsfield env is set, so no clip_path exists to cut. It reports
  // which of those it is rather than "not ready".
  const readiness = editReadiness(brief, (frameRows ?? []) as FrameRowForEdit[]);
  if (!readiness.ready) {
    await appendEvent(sb, job.id, readiness.message, "warn", {
      stage: "readiness",
      reason: readiness.reason,
    });
    return failed(readiness.message);
  }

  const { data: brandRow } = await sb
    .from("client_brand_profiles")
    .select("never_do, colour_background, colour_text")
    .eq("client_id", asset.client_id)
    .maybeSingle();
  const brand = (brandRow ?? null) as
    | { never_do: string | null; colour_background: string | null; colour_text: string | null }
    | null;

  // Before the clips, and well before the model: a cut this ffmpeg cannot
  // render is a cut not worth planning. Discovering it afterwards is how the
  // first real attempt spent a plan and a revision to arrive at "Invalid
  // argument".
  const capable = await renderCapability();
  if (!capable.ok) {
    await appendEvent(sb, job.id, capable.message, "error", { stage: "preflight" });
    return failed(capable.message);
  }

  const work = await mkdtemp(join(tmpdir(), "reel-cut-"));
  try {
    return await cut(sb, config, job, asset, brief, readiness.shots, brand, work, deadlineMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendEvent(sb, job.id, `The cut failed: ${message}`, "error", { stage: "cut" });
    // Retryable: a download, an ffmpeg timeout or a provider blip are all
    // worth a second attempt, and nothing durable has been written yet.
    return failed(message, true);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function cut(
  sb: SupabaseClient,
  config: RuntimeConfig,
  job: AgentJobRow,
  asset: AssetRow,
  brief: BriefForEdit,
  shots: readonly EditShot[],
  brand: { never_do: string | null; colour_background: string | null; colour_text: string | null } | null,
  work: string,
  deadlineMs?: number,
): Promise<JobResult> {
  await appendEvent(sb, job.id, `Cutting ${shots.length} shots of "${brief.title ?? "this reel"}".`);

  // Clips to local disk: ffprobe and ffmpeg read paths, not streams.
  const clipPaths = new Map<number, string>();
  const probed = new Map<number, number>();
  for (const shot of shots) {
    const { data, error } = await sb.storage.from(BUCKET).download(shot.clipPath);
    if (error || !data) throw new Error(`Could not download the clip for shot ${shot.shot}.`);
    const local = join(work, `shot-${String(shot.shot).padStart(2, "0")}.mp4`);
    await writeFile(local, Buffer.from(await data.arrayBuffer()));
    clipPaths.set(shot.shot, local);
    probed.set(shot.shot, await probeDurationSec(local));
  }

  const clips: PlanClip[] = [];
  for (const shot of shots) {
    clips.push({
      shot: shot.shot,
      beat: shot.beat,
      duration_sec: probed.get(shot.shot) ?? shot.plannedDurationSec,
      shot_source_kind: shot.shotSourceKind,
      frames: await sampleFrames(clipPaths.get(shot.shot)!, work, { fps: SAMPLE_FPS, width: SAMPLE_WIDTH }),
    });
  }

  const context = editContext({
    shots,
    probedDurations: probed,
    brief,
    neverDo: brand?.never_do ?? null,
    maxTotalSec: maxReelSeconds(shots),
  });
  const planInput = {
    title: brief.title ?? "Reel",
    briefText: briefTextForEdit(brief),
    maxTotalSec: maxReelSeconds(shots),
    bannedPhrases: bannedPhrases(brand?.never_do),
    clips,
  };

  const timeoutMs = deadlineMs ? Math.max(30_000, deadlineMs - Date.now()) : undefined;
  let plan = await planEdit(planInput, { model: config.model, timeoutMs });
  let usage = { ...plan.usage };
  let edl: Edl = plan.edl;
  let problems = validateEdl(edl, context);

  if (problems.length > 0) {
    // One revise, with every problem named. A second failure is a refusal,
    // not a third attempt: the planner has now been told twice.
    await appendEvent(sb, job.id, `The first cut had ${problems.length} problem(s). Asking for a revision.`, "warn", {
      stage: "validate",
      problems,
    });
    plan = await planEdit({ ...planInput, revise: { edl, problems } }, { model: config.model, timeoutMs });
    usage = {
      inputTokens: usage.inputTokens + plan.usage.inputTokens,
      outputTokens: usage.outputTokens + plan.usage.outputTokens,
      costUsd: usage.costUsd + plan.usage.costUsd,
    };
    edl = plan.edl;
    problems = validateEdl(edl, context);
  }

  if (problems.length > 0) {
    const message = `The cut could not be validated: ${problems.join(" ")}`;
    await appendEvent(sb, job.id, message, "error", { stage: "validate", problems });
    // Not retryable. The same brief and the same clips produce the same
    // refusal, and the editor handoff is a person's decision from here.
    return { ok: false, retryable: false, failureMessage: message, usage };
  }

  const outputPath = join(work, "cut.mp4");
  const renderPlan = buildRenderPlan(edl, {
    clipPaths,
    outputPath,
    fontFile: await installFont(work),
    workDir: work,
    backgroundColour: brand?.colour_background ?? null,
    textColour: brand?.colour_text ?? null,
  });
  await render(renderPlan);
  await appendEvent(sb, job.id, `Rendered ${totalDuration(edl).toFixed(1)}s at 1080x1920.`);

  const storagePath = renderStoragePath(asset.client_id, asset.id);
  const { readFile } = await import("node:fs/promises");
  const { error: upError } = await sb.storage
    .from(BUCKET)
    .upload(storagePath, await readFile(outputPath), { contentType: "video/mp4", upsert: true });
  if (upError) throw new Error(`Could not store the cut: ${upError.message}`);

  const { error: saveError } = await sb
    .from("client_media_assets")
    .update({ edit_plan: edl as unknown as Record<string, unknown>, render_path: storagePath })
    .eq("id", asset.id);
  if (saveError) throw new Error(`Could not file the cut: ${saveError.message}`);

  await appendEvent(sb, job.id, "The cut is on the reel and waiting for a person.", "info", {
    stage: "done",
    render_path: storagePath,
  });
  return { ok: true, retryable: false, usage };
}

export { parseEdl };
