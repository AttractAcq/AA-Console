import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import { anthropicKeyForAgent } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { validateEdl, type Edl } from "../video_edit/edl.js";
import { bannedPhrases } from "../video_edit/handoff.js";
import { installFont } from "../video_edit/font.js";
import { probeDurationSec, render, sampleFrames } from "../video_edit/media.js";
import { planEdit } from "../video_edit/plan.js";
import { DIMENSIONS, buildSourceRenderPlan, type Aspect } from "./render.js";
import { sourceEditCapability } from "./preflight.js";
import { captionsForCut, hasAudioStream, transcribeSource, type Transcript } from "./transcript.js";

const BUCKET = "client-media";
const MAX_SOURCE_SECONDS = 180;

type Request = { id: string; client_id: string; source_asset_id: string; status: string;
  direction: string; aspect: Aspect; remove_pauses: boolean; captions: boolean;
  animated_title: boolean; brand_treatment: string; feel: string; output_asset_id: string | null;
  created_by: string | null };
type Source = { id: string; client_id: string; brief_id: string; title: string | null;
  content_format: string; storage_path: string; edit_stage: string };

const SYSTEM = `You are editing one supplied video, with its original audio retained.
The images are sampled frames, and the word list is a timecoded transcript of the source.
Submit a timecoded EDL using submit_edit_plan. Every segment must use shot 1 and transition cut.
Keep the speaker's words intact; do not splice syllables or rearrange speech into a false statement.
Follow the operator's direction and edit feel. When asked to remove pauses, trim substantial silent gaps
between spoken phrases. Do not remove pauses needed for meaning. Use visual frames to choose clean cuts.
Set captions to [], end_card_text to "", and end_card_sec to 0; captions are later generated only from
the transcribed words retained in the selected cuts. Do not invent quotes, facts, or visuals.
Explain your choices in notes for the human reviewer.`;

function prompt(request: Request, transcript: Transcript, duration: number): string {
  const words = transcript.words.map((word) =>
    `${word.start.toFixed(2)}-${word.end.toFixed(2)} ${word.word}`).join("\n");
  return [
    `Operator direction: ${request.direction}`,
    `Source duration: ${duration.toFixed(2)}s. Output aspect: ${request.aspect}.`,
    `Feel: ${request.feel}. Brand treatment: ${request.brand_treatment}.`,
    `Remove substantial pauses: ${request.remove_pauses ? "yes" : "no"}.`,
    `Captions and animated title are added by the renderer: ${request.captions ? "captions" : "no captions"}, ${request.animated_title ? "animated title" : "no title"}.`,
    "Transcript with source timecodes:",
    words || "No spoken words were detected.",
  ].join("\n");
}

async function failRequest(sb: SupabaseClient, request: Request, message: string): Promise<void> {
  const { error } = await sb.rpc("fail_source_video_edit", {
    p_request_id: request.id, p_error: message.slice(0, 1000),
  });
  if (error) throw new Error(`Could not mark source edit failed: ${error.message}`);
}

export async function runSourceVideoEditJob(sb: SupabaseClient, config: RuntimeConfig,
  _agent: AgentRow, job: AgentJobRow, deadlineAt?: number): Promise<JobResult> {
  const requestId = typeof job.params?.request_id === "string" ? job.params.request_id : null;
  if (!requestId || job.input_table !== "client_media_assets" || !job.input_id || !job.client_id) {
    return { ok: false, retryable: false, failureMessage: "A source edit needs its request and source asset." };
  }
  const { data: row, error: requestError } = await sb.from("video_source_edit_requests")
    .select("*").eq("id", requestId).maybeSingle();
  if (requestError || !row) return { ok: false, retryable: false,
    failureMessage: requestError?.message ?? "The edit request is missing." };
  const request = row as Request;
  if (request.source_asset_id !== job.input_id || request.client_id !== job.client_id) {
    return { ok: false, retryable: false, failureMessage: "The edit request does not match its source." };
  }
  if (request.status === "completed") return { ok: true, retryable: false };
  if (request.status === "failed") return { ok: false, retryable: false,
    failureMessage: "This edit request already failed; make a new request to retry." };
  const { data: sourceRow, error: sourceError } = await sb.from("client_media_assets")
    .select("id, client_id, brief_id, title, content_format, storage_path, edit_stage")
    .eq("id", request.source_asset_id).maybeSingle();
  if (sourceError || !sourceRow) return { ok: false, retryable: false,
    failureMessage: sourceError?.message ?? "The source footage is missing." };
  const source = sourceRow as Source;
  if (source.client_id !== request.client_id || source.edit_stage !== "editing") {
    return { ok: false, retryable: false, failureMessage: "The source is no longer awaiting this edit." };
  }
  const { error: startError } = await sb.from("video_source_edit_requests")
    .update({ status: "running", error: null }).eq("id", request.id);
  if (startError) return { ok: false, retryable: false, failureMessage: startError.message };
  const work = await mkdtemp(join(tmpdir(), "source-video-edit-"));
  let usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  try {
    const capability = await sourceEditCapability(request.captions || request.animated_title);
    if (capability) throw new Error(capability);
    const { data: file, error: downloadError } = await sb.storage.from(BUCKET).download(source.storage_path);
    if (downloadError || !file) throw new Error(`Could not download source footage: ${downloadError?.message ?? "missing file"}`);
    if (file.size > 250 * 1024 * 1024) throw new Error("AI editing currently supports source files up to 250 MB.");
    const local = join(work, "source.mp4");
    await writeFile(local, Buffer.from(await file.arrayBuffer()));
    const duration = await probeDurationSec(local);
    if (duration > MAX_SOURCE_SECONDS) throw new Error("AI editing currently supports videos up to 3 minutes.");
    const hasAudio = await hasAudioStream(local);
    if (!hasAudio && (request.captions || request.remove_pauses)) {
      throw new Error("This video has no audio; turn off captions and pause removal to edit it.");
    }
    if (hasAudio && !config.openaiApiKey) {
      throw new Error("OPENAI_API_KEY is needed for timed speech transcription.");
    }
    await appendEvent(sb, job.id, `Source checked: ${duration.toFixed(1)}s, audio ${hasAudio ? "present" : "absent"}.`);
    const transcript = hasAudio ? await transcribeSource(local, work, config.openaiApiKey!, duration)
      : { text: "", words: [], language: null };
    if (request.captions && transcript.words.length === 0) {
      throw new Error("No timed speech was found, so captions cannot be generated.");
    }
    const transcriptionCost = hasAudio ? Math.ceil(duration) / 60 * 0.006 : 0;
    usage.costUsd += transcriptionCost;
    await sb.from("video_source_edit_requests").update({ transcript }).eq("id", request.id);
    const frameDir = join(work, "frames");
    const frames = await sampleFrames(local, frameDir, { fps: Math.min(0.5, 24 / duration), width: 384 });
    const { data: brand } = await sb.from("client_brand_profiles")
      .select("never_do, colour_text").eq("client_id", request.client_id).maybeSingle();
    const planInput = { title: source.title ?? "Supplied video",
      briefText: prompt(request, transcript, duration), maxTotalSec: duration,
      bannedPhrases: bannedPhrases(brand?.never_do ?? null),
      clips: [{ shot: 1, beat: "Supplied footage", duration_sec: duration,
        shot_source_kind: "source_asset", burnedInText: "", frames }] };
    const options = { apiKey: anthropicKeyForAgent(config, "source_video_edit"), model: config.model,
      system: SYSTEM, timeoutMs: deadlineAt ? Math.max(30_000, deadlineAt - Date.now()) : undefined };
    let planned = await planEdit(planInput, options);
    usage = { inputTokens: planned.usage.inputTokens, outputTokens: planned.usage.outputTokens,
      costUsd: usage.costUsd + planned.usage.costUsd };
    const clean = (edl: Edl): Edl => ({ ...edl, captions: [], end_card_text: "", end_card_sec: 0 });
    let edl = clean(planned.edl);
    const context = { clips: [{ shot: 1, duration_sec: duration,
      shot_source_kind: "source_asset", burned_in_text: "" }],
      max_total_sec: duration, brief_text: transcript.text,
      banned_phrases: bannedPhrases(brand?.never_do ?? null) };
    let problems = validateEdl(edl, context);
    if (problems.length) {
      planned = await planEdit({ ...planInput, revise: { edl, problems } }, options);
      usage = { inputTokens: usage.inputTokens + planned.usage.inputTokens,
        outputTokens: usage.outputTokens + planned.usage.outputTokens,
        costUsd: usage.costUsd + planned.usage.costUsd };
      edl = clean(planned.edl);
      problems = validateEdl(edl, context);
    }
    if (problems.length) throw new Error(`Claude could not make a valid cut: ${problems.join(" ")}`);
    if (request.captions) edl.captions = captionsForCut(edl, transcript.words);
    problems = validateEdl(edl, context);
    if (problems.length) throw new Error(`The timed captions could not be rendered: ${problems.join(" ")}`);
    await sb.from("video_source_edit_requests").update({ edit_plan: edl }).eq("id", request.id);
    const output = join(work, "cut.mp4");
    const renderPlan = buildSourceRenderPlan(edl, { sourcePath: local, outputPath: output,
      workDir: work, fontFile: await installFont(work), aspect: request.aspect,
      hasAudio, animatedTitle: request.animated_title ? source.title : null,
      textColour: request.brand_treatment === "on_brand" ? brand?.colour_text : null });
    await render(renderPlan);
    const storagePath = `${request.client_id}/edits/${request.id}/cut.mp4`;
    const { error: uploadError } = await sb.storage.from(BUCKET).upload(storagePath,
      await readFile(output), { contentType: "video/mp4", upsert: true });
    if (uploadError) throw new Error(`Could not store the edited video: ${uploadError.message}`);
    const dimensions = DIMENSIONS[request.aspect];
    const { error: completeError } = await sb.rpc("complete_source_video_edit", {
      p_request_id: request.id, p_storage_path: storagePath, p_edit_plan: edl,
      p_width: dimensions.width, p_height: dimensions.height,
      p_duration_sec: Number(renderPlan.durationSec.toFixed(2)),
    });
    if (completeError) throw new Error(`Could not register the edited version: ${completeError.message}`);
    await appendEvent(sb, job.id, "Edited version is ready for owner and SMM review.", "info",
      { output_asset_id: request.id, transcription_estimate_usd: transcriptionCost });
    return { ok: true, retryable: false, usage };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendEvent(sb, job.id, `Source edit failed: ${message}`, "error");
    await failRequest(sb, request, message);
    return { ok: false, retryable: false, failureMessage: message, usage };
  } finally { await rm(work, { recursive: true, force: true }); }
}
