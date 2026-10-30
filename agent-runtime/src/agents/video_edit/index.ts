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

import { createHash } from "node:crypto";
import { PRIVATE_OBJECT_CACHE_CONTROL_SECONDS } from "../../storage/signed-url-policy.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  visualBriefForReview,
  type BriefForEdit,
  type EditShot,
  type FrameRowForEdit,
} from "./handoff.js";
import { hasAudioStream, probeDurationSec, render, renderCapability, sampleFrames } from "./media.js";
import { installFont } from "./font.js";
import { briefCopyProblems, communicationProblems, planEdit, sameRenderedCut, type PlanClip } from "./plan.js";
import { advanceSlot, slotIdOf } from "../../engine/slot.js";
import { buildRenderPlan } from "./render.js";
import { probeRenderedVideo, reviewRenderedVideo } from "./acceptance.js";
import { ProviderError } from "../../tools/anthropic.js";
import { uploadRenderedCut } from "./upload.js";

const BUCKET = "client-media";
/** Enough to read the cut without paying for every frame of it. */
const SAMPLE_FPS = 1;
const SAMPLE_WIDTH = 384;

const failed = (failureMessage: string, retryable = false): JobResult => ({
  ok: false,
  retryable,
  failureMessage,
});

/**
 * Held, not failed: a refusal that passes without anybody acting.
 *
 * Higgsfield clips take minutes. A reel whose footage is still rendering is
 * in the same position as a client over its monthly cap — the thing in the
 * way goes away on its own, and `failed` would both strand the slot and lose
 * the work. resume_paused_jobs re-queues it hourly.
 */
const held = (failureMessage: string): JobResult => ({
  ok: false,
  retryable: false,
  hold: true,
  failureMessage,
});

export function renderStoragePath(clientId: string, assetId: string, jobId: string, attempt: number,
  digest: string): string {
  return `${clientId}/reels/${assetId}/candidates/${jobId}-${attempt}-${digest}.mp4`;
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
      "id, title, media_type, content_format, format_code, frame_plan, visual_direction, hook, script, call_to_action, proof, channel_intent, sound_treatment, sound_asset_id",
    )
    .eq("id", asset.brief_id)
    .maybeSingle();
  if (briefError) return failed(`Could not load the brief: ${briefError.message}`, true);
  const brief = briefRow as BriefForEdit | null;
  if (!brief) return failed("That reel's brief no longer exists.");
  if (brief.sound_treatment && brief.sound_treatment !== "captions_only" && !brief.sound_asset_id) {
    return failed("The requested sound treatment has no approved audio source.");
  }

  // A worker may lose its lease after the candidate was accepted but before
  // it reported job completion. Resume from the accepted exact file instead
  // of paying for another edit or overwriting it.
  const { data: acceptedCandidate, error: priorError } = await sb
    .from("video_render_candidates")
    .select("id, render_path")
    .eq("job_id", job.id)
    .eq("verdict", "accepted")
    .order("attempt", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (priorError) return failed(`Could not check prior accepted cut: ${priorError.message}`, true);
  if (acceptedCandidate) {
    const slotId = slotIdOf(job);
    if (slotId) {
      const { data: slot, error: slotError } = await sb.from("content_slots")
        .select("stage, asset_id").eq("id", slotId).maybeSingle();
      if (slotError || !slot) return failed(`Could not inspect resumed slot: ${slotError?.message ?? "missing"}`, true);
      if (slot.asset_id === asset.id && ["copywriting", "qa", "awaiting_approval",
        "scheduled", "published"].includes(slot.stage)) return { ok: true, retryable: false };
      if (slot.stage !== "building") return failed(`Accepted cut is attached to a slot at ${slot.stage}; manual review is needed.`);
      await advanceSlot(sb, slotId, "copywriting", {
        agentKey: "video_edit", jobId: job.id, assetId: asset.id,
        note: "Resumed the already accepted exact cut.",
      });
    }
    return { ok: true, retryable: false };
  }

  const { data: frameRows, error: frameError } = await sb
    .from("client_media_frames")
    .select("id, position, beat, duration_sec, shot_source_kind, clip_path, provider_job_id, caption")
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
    // The one reason that is a wait rather than a fault. Everything else
    // here — no shot plan, a plan that does not match the frames, a shot
    // nobody submitted — needs somebody to do something.
    return readiness.reason === "clips_rendering" ? held(readiness.message) : failed(readiness.message);
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
    // A retry uses a new attempt number and therefore a distinct candidate.
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
      burnedInText: shot.burnedInText,
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
    priorCandidateFailure: (() => {
      const prior = job.params?.v5_video_revision;
      if (!prior || typeof prior !== "object") return null;
      const feedback = prior as Record<string, unknown>;
      return typeof feedback.candidate_id === "string" && typeof feedback.reason === "string"
        ? { candidateId: feedback.candidate_id, reason: feedback.reason,
          editPlan: feedback.edit_plan }
        : null;
    })(),
  };

  const rejected = async (candidateId: string, reason: string): Promise<JobResult> => {
    if (typeof job.params?.v5_workflow_run_id !== "string"
      || job.attempts >= job.max_attempts) return failed(reason);
    const { error } = await sb.rpc("stage_video_candidate_revision", {
      p_candidate_id: candidateId,
    });
    if (error) throw new Error(`Could not stage a controlled reel revision: ${error.message}`);
    await appendEvent(sb, job.id, "A revised cut will use the rejected candidate's findings.", "info", {
      candidate_id: candidateId, next_attempt: job.attempts + 1,
    });
    return failed(reason, true);
  };

  const timeoutMs = deadlineMs ? Math.max(30_000, deadlineMs - Date.now()) : undefined;
  let plan = await planEdit(planInput, { model: config.model, timeoutMs });
  let usage = { ...plan.usage };
  let edl: Edl = plan.edl;
  // Legacy artwork can already carry a line in its pixels. The exact-copy
  // gate applies to the new text-free generated footage, whose words are all
  // supplied by the editor and therefore checkable before rendering.
  const copyProblems = (cut: Edl) => clips.some((clip) => clip.burnedInText.trim())
    ? [] : briefCopyProblems(cut, brief);
  const planProblems = (candidate: Edl): string[] => {
    const found = [...validateEdl(candidate, context), ...communicationProblems(candidate, clips),
      ...copyProblems(candidate)];
    if (sameRenderedCut(candidate, planInput.priorCandidateFailure?.editPlan))
      found.push("The cut repeats the rejected edit plan exactly.");
    return found;
  };
  let problems = planProblems(edl);
  for (let revision = 1; problems.length > 0 && revision <= 2; revision += 1) {
    await appendEvent(sb, job.id,
      `The edit plan had ${problems.length} problem(s). Asking for revision ${revision}/2.`, "warn",
      { stage: "validate", revision, problems });
    plan = await planEdit({ ...planInput, revise: { edl, problems } }, {
      model: config.model,
      timeoutMs: deadlineMs ? Math.max(30_000, deadlineMs - Date.now()) : timeoutMs,
    });
    usage = {
      inputTokens: usage.inputTokens + plan.usage.inputTokens,
      outputTokens: usage.outputTokens + plan.usage.outputTokens,
      costUsd: usage.costUsd + plan.usage.costUsd,
    };
    edl = plan.edl;
    problems = planProblems(edl);
  }

  if (problems.length > 0) {
    const message = `The cut could not be validated: ${problems.join(" ")}`;
    await appendEvent(sb, job.id, message, "error", { stage: "validate", problems });
    // Not retryable. The same brief and the same clips produce the same
    // refusal, and the editor handoff is a person's decision from here.
    return { ok: false, retryable: false, failureMessage: message, usage };
  }

  const outputPath = join(work, "cut.mp4");
  let soundPath: string | null = null;
  const soundTreatment = brief.sound_treatment ?? "captions_only";
  if (soundTreatment !== "captions_only") {
    const { data: sound, error: soundError } = await sb.from("video_sound_assets")
      .select("client_id, kind, storage_path, rights_reference, attested_at")
      .eq("id", brief.sound_asset_id!).maybeSingle();
    if (soundError || !sound || sound.client_id !== asset.client_id
      || sound.kind !== soundTreatment || !sound.rights_reference || !sound.attested_at) {
      return failed(`The ${soundTreatment} source is unavailable or lacks rights attestation.`);
    }
    const { data, error } = await sb.storage.from(BUCKET).download(sound.storage_path);
    if (error || !data) return failed(`Could not download the approved ${soundTreatment} source.`, true);
    soundPath = join(work, "approved-sound.m4a");
    await writeFile(soundPath, Buffer.from(await data.arrayBuffer()));
    if (!await hasAudioStream(soundPath)) {
      return failed(`The approved ${soundTreatment} file has no decodable audio stream.`);
    }
    const soundDuration = await probeDurationSec(soundPath);
    if (soundDuration + 0.1 < totalDuration(edl)) {
      return failed(`The approved ${soundTreatment} file ends before this cut; choose a longer source.`);
    }
  }
  const renderPlan = buildRenderPlan(edl, {
    clipPaths,
    outputPath,
    fontFile: await installFont(work),
    workDir: work,
    musicPath: soundPath,
    backgroundColour: brand?.colour_background ?? null,
    textColour: brand?.colour_text ?? null,
  });
  await render(renderPlan);
  await appendEvent(sb, job.id, `Rendered ${totalDuration(edl).toFixed(1)}s at 1080x1920.`);

  const bytes = await readFile(outputPath);
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 24);
  const storagePath = renderStoragePath(asset.client_id, asset.id, job.id, job.attempts, digest);
  const probe = await probeRenderedVideo(outputPath, soundTreatment !== "captions_only");
  await uploadRenderedCut(
    () => sb.storage.from(BUCKET).upload(storagePath, bytes, {
      contentType: "video/mp4", upsert: true, cacheControl: PRIVATE_OBJECT_CACHE_CONTROL_SECONDS,
    }),
    { onRetry: (attempt, reason) => void appendEvent(sb, job.id,
      `Storage returned a temporary error after rendering. Retrying this exact cut (${attempt}/3): ${reason}`, "warn") },
  );
  const { data: candidate, error: recordError } = await sb.rpc("record_video_render_candidate", {
    p_job_id: job.id, p_attempt: job.attempts, p_asset_id: asset.id,
    p_render_path: storagePath, p_media_probe: probe,
  });
  if (recordError || !candidate) throw new Error(`Could not record candidate: ${recordError?.message ?? "empty result"}`);
  const candidateId = (candidate as { id: string }).id;
  if (probe.result === "fail") {
    const reason = probe.checks.join(" ");
    const { error } = await sb.rpc("decide_video_render_candidate", {
      p_candidate_id: candidateId, p_verdict: "rejected",
      p_creative_review: { result: "fail", checks: [{ area: "media_probe", verdict: "fail", reason }] },
      p_rejection_reason: reason,
      p_edit_plan: edl,
    });
    if (error) throw new Error(`Could not reject candidate: ${error.message}`);
    await appendEvent(sb, job.id, `The rendered candidate failed media inspection: ${reason}`, "warn", {
      candidate_id: candidateId, stage: "media_probe", probe,
    });
    return rejected(candidateId, `Rendered candidate failed media inspection: ${reason}`);
  }
  let creative;
  try {
    creative = await reviewRenderedVideo({
      path: outputPath, workDir: work, brief: briefTextForEdit(brief),
      visualBrief: visualBriefForReview(brief),
      brandNeverDo: brand?.never_do ?? "",
      durationSec: probe.duration_sec,
      soundTreatment: probe.has_audio ? "audio_present" : "captions_only",
    }, { model: config.model, timeoutMs: deadlineMs ? Math.max(30_000, deadlineMs - Date.now()) : undefined });
  } catch (error) {
    if (!(error instanceof ProviderError) || error.retryable) throw error;
    const reason = `Creative review unavailable: ${error.message}`;
    const { error: decisionError } = await sb.rpc("decide_video_render_candidate", {
      p_candidate_id: candidateId, p_verdict: "rejected",
      p_creative_review: { result: "fail", checks: [
        { area: "review_contract", verdict: "fail", reason, at_sec: null },
      ], summary: reason },
      p_rejection_reason: reason, p_edit_plan: edl,
    });
    if (decisionError) throw new Error(`Could not close unreviewed candidate: ${decisionError.message}`);
    await appendEvent(sb, job.id, reason, "error", { candidate_id: candidateId, stage: "creative_review" });
    return failed(reason);
  }
  usage = {
    inputTokens: usage.inputTokens + creative.usage.inputTokens,
    outputTokens: usage.outputTokens + creative.usage.outputTokens,
    costUsd: usage.costUsd + creative.usage.costUsd,
  };
  const verdict = creative.result === "pass" ? "accepted" : "rejected";
  const { error: decisionError } = await sb.rpc("decide_video_render_candidate", {
    p_candidate_id: candidateId, p_verdict: verdict,
    p_creative_review: creative,
    p_rejection_reason: creative.result === "fail" ? creative.summary : null,
    p_edit_plan: edl,
  });
  if (decisionError) throw new Error(`Could not file creative review: ${decisionError.message}`);
  if (verdict === "rejected") {
    await appendEvent(sb, job.id, `The rendered candidate failed visual review: ${creative.summary}`, "warn", {
      candidate_id: candidateId, stage: "creative_review", review: creative,
    });
    return { ...await rejected(candidateId, creative.summary), usage };
  }
  await appendEvent(sb, job.id, "The cut is on the reel and waiting for a person.", "info", {
    stage: "done",
    render_path: storagePath, candidate_id: candidateId, internal_review: creative,
  });

  // The slot moves on only now, with a cut on the asset. Before this the
  // engine advanced a reel to copywriting as soon as its clips were
  // submitted, so a person could be asked to approve footage that had never
  // been assembled. Does nothing for a hand-run job, which has no slot.
  const slotId = slotIdOf(job);
  if (slotId) {
    await advanceSlot(sb, slotId, "copywriting", {
      agentKey: "video_edit",
      jobId: job.id,
      assetId: asset.id,
      costUsd: usage.costUsd,
      note: `Cut at ${totalDuration(edl).toFixed(1)}s.`,
    });
  }

  return { ok: true, retryable: false, usage };
}

export { parseEdl };
