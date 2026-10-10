import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { probeDurationSec } from "../video_edit/media.js";
import { hasAudioStream } from "../source_video_edit/transcript.js";
import { motionCapability } from "../motion_design/render.js";
import { extractRepurposeClip } from "./clip.js";

type Request = { id: string; derivative_id: string; source_asset_id: string;
  brief_id: string; client_id: string; source_in_sec: number; source_out_sec: number;
  status: string; output_asset_id: string | null };

export async function runRepurposeClipJob(sb: SupabaseClient, _config: RuntimeConfig,
  _agent: AgentRow, job: AgentJobRow): Promise<JobResult> {
  const requestId = typeof job.params?.request_id === "string" ? job.params.request_id : null;
  if (!requestId || job.input_table !== "video_repurpose_derivatives" || !job.input_id
      || !job.client_id) return { ok: false, retryable: false,
    failureMessage: "A selected derivative and clip request are required." };
  const { data, error } = await sb.from("video_repurpose_clip_requests")
    .select("*").eq("id", requestId).maybeSingle();
  if (error || !data) return { ok: false, retryable: false,
    failureMessage: error?.message ?? "Clip extraction request missing." };
  const request = data as Request;
  if (request.client_id !== job.client_id || request.derivative_id !== job.input_id) {
    return { ok: false, retryable: false, failureMessage: "Clip request does not match its derivative." };
  }
  if (request.status === "completed") return { ok: true, retryable: false };
  const { data: source, error: sourceError } = await sb.from("client_media_assets")
    .select("id, client_id, media_type, review_status, edit_stage, storage_path, render_path")
    .eq("id", request.source_asset_id).maybeSingle();
  if (sourceError || !source || source.client_id !== request.client_id || source.media_type !== "video"
      || source.review_status === "rejected" || source.edit_stage === "superseded") {
    return { ok: false, retryable: false, failureMessage: "The source video can no longer be clipped." };
  }
  const { error: startError } = await sb.from("video_repurpose_clip_requests")
    .update({ status: "running", error: null }).eq("id", request.id);
  if (startError) return { ok: false, retryable: false, failureMessage: startError.message };
  const work = await mkdtemp(join(tmpdir(), "repurpose-clip-"));
  try {
    const capability = await motionCapability();
    if (capability) throw new Error(capability);
    const sourcePath = source.render_path || source.storage_path;
    const { data: file, error: downloadError } = await sb.storage.from("client-media").download(sourcePath);
    if (downloadError || !file) throw new Error(`Could not download source video: ${downloadError?.message ?? "missing"}`);
    if (file.size > 500 * 1024 * 1024) throw new Error("Clip extraction supports videos up to 500 MB.");
    const input = join(work, "source.mp4");
    const output = join(work, "clip.mp4");
    await writeFile(input, Buffer.from(await file.arrayBuffer()));
    const duration = await probeDurationSec(input);
    if (request.source_out_sec > duration + 0.1) throw new Error("Clip range exceeds source duration.");
    if (!await hasAudioStream(input)) throw new Error("The source audio is no longer available.");
    await extractRepurposeClip(input, output, request.source_in_sec, request.source_out_sec);
    if (!await hasAudioStream(output)) throw new Error("The extracted clip lost its audio.");
    const clipDuration = await probeDurationSec(output);
    const path = `${request.client_id}/repurpose-clips/${request.id}/source.mp4`;
    const { error: uploadError } = await sb.storage.from("client-media").upload(path,
      await readFile(output), { upsert: true, contentType: "video/mp4" });
    if (uploadError) throw new Error(`Could not store extracted clip: ${uploadError.message}`);
    const { error: completeError } = await sb.rpc("complete_repurpose_clip", {
      p_request_id: request.id, p_storage_path: path,
      p_duration_sec: Number(clipDuration.toFixed(2)),
    });
    if (completeError) throw new Error(completeError.message);
    await appendEvent(sb, job.id, "Repurposed clip created and sent to Edit / Repurpose.");
    return { ok: true, retryable: false };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    await sb.from("video_repurpose_clip_requests").update({ status: "failed", error: message.slice(0, 1000) })
      .eq("id", request.id);
    await appendEvent(sb, job.id, `Clip extraction failed: ${message}`, "error");
    return { ok: false, retryable: false, failureMessage: message };
  } finally { await rm(work, { recursive: true, force: true }); }
}
