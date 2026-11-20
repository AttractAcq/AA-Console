import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { renderTimingsFromReceipts } from "../audio/render-timings.js";
import { parseRuntimeIR } from "../validate.js";

type Project = { id: string; client_id: string; stage: string;
  ir_version: number; audio_ir_version: number | null;
  ir: unknown; music_path: string | null };
type Scene = { id: string; client_id: string; project_id: string;
  position: number; scene_key: string; narration: string;
  audio_path: string | null; duration_sec: number | null;
  alignment: unknown };
type Receipt = { scene_id: string; client_id: string; project_id: string;
  ir_version: number; narration_sha256: string; audio_sha256: string;
  storage_path: string; file_bytes: number; duration_sec: number;
  alignment: unknown; alignment_loss: number };
type MusicReceipt = { client_id: string; project_id: string;
  ir_version: number; storage_path: string; audio_sha256: string;
  file_bytes: number };
type MusicAttempt = { client_id: string; project_id: string;
  ir_version: number; state: string; requested: boolean };

const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** The existing completion RPC rechecks each receipt against the current
 * Storage object identity, exact IR and source while the project is `timed`.
 * Call before and after byte verification so an object replacement cannot be
 * hidden by a stale signed URL. Later render stages need their own preflight.
 */
async function verifyCompletedAudio(sb: SupabaseClient, projectId: string,
  irVersion: number): Promise<void> {
  const result = await sb.rpc("complete_video_audio_project_v1", {
    p_project_id: projectId, p_ir_version: irVersion,
  });
  if (result.error || result.data !== true) {
    throw new Error("Render audio is no longer complete or current.");
  }
}

export async function buildVideoRenderInputs(input: {
  sb: SupabaseClient; clientId: string; projectId: string;
  maxAlignmentLoss: number;
}) {
  const { sb, clientId, projectId } = input;
  const projectResult = await sb.from("video_projects")
    .select("id,client_id,stage,ir_version,audio_ir_version,ir,music_path")
    .eq("id", projectId).eq("client_id", clientId).maybeSingle();
  const project = projectResult.data as Project | null;
  if (projectResult.error || !project || project.id !== projectId
    || project.client_id !== clientId || project.stage !== "timed"
    || !Number.isInteger(project.ir_version) || project.ir_version < 1) {
    throw new Error("Video project is not in the exact timed state.");
  }
  const ir = parseRuntimeIR(project.ir);
  const audioVersion = project.audio_ir_version ?? project.ir_version;
  if (!Number.isInteger(audioVersion) || audioVersion < 1
    || audioVersion > project.ir_version) {
    throw new Error("Video audio version binding is invalid.");
  }
  await verifyCompletedAudio(sb, projectId, project.ir_version);
  const [scenesResult, receiptsResult, musicResult, musicAttemptResult] = await Promise.all([
    sb.from("video_scenes")
      .select("id,client_id,project_id,position,scene_key,narration,audio_path,duration_sec,alignment")
      .eq("project_id", projectId).eq("client_id", clientId).order("position"),
    sb.from("video_scene_audio_receipts_v1")
      .select("scene_id,client_id,project_id,ir_version,narration_sha256,audio_sha256,storage_path,file_bytes,duration_sec,alignment,alignment_loss")
      .eq("project_id", projectId).eq("client_id", clientId)
      .eq("ir_version", audioVersion),
    sb.from("video_project_music_receipts_v1")
      .select("client_id,project_id,ir_version,storage_path,audio_sha256,file_bytes")
      .eq("project_id", projectId).eq("client_id", clientId)
      .eq("ir_version", audioVersion).maybeSingle(),
    sb.from("video_project_music_attempts_v1")
      .select("client_id,project_id,ir_version,state,requested")
      .eq("project_id", projectId).eq("client_id", clientId)
      .eq("ir_version", audioVersion).maybeSingle(),
  ]);
  if (scenesResult.error || receiptsResult.error || musicResult.error
    || musicAttemptResult.error) {
    throw new Error("Video render audio evidence could not be read.");
  }
  const scenes = scenesResult.data as Scene[] | null;
  const receipts = receiptsResult.data as Receipt[] | null;
  const musicReceipt = musicResult.data as MusicReceipt | null;
  const musicAttempt = musicAttemptResult.data as MusicAttempt | null;
  if (!musicAttempt || musicAttempt.client_id !== clientId
    || musicAttempt.project_id !== projectId
    || musicAttempt.ir_version !== audioVersion
    || musicAttempt.requested !== ir.music.enabled
    || !["filed", "failed", "skipped"].includes(musicAttempt.state)
    || (musicAttempt.state === "filed") !== (musicReceipt !== null)
    || (musicAttempt.state === "filed") !== (project.music_path !== null)) {
    throw new Error("Video music outcome is not terminal or disagrees with the filed bed.");
  }
  const irScenes = ir.scenes as unknown as Array<{ id: string; narration: string }>;
  if (!scenes || !receipts || scenes.length !== ir.scenes.length
    || scenes.some((scene, index) => scene.scene_key !== irScenes[index]?.id
      || scene.narration !== irScenes[index]?.narration)) {
    throw new Error("Persisted video scenes differ from the exact IR.");
  }
  const files = receipts.map((receipt) => ({ path: receipt.storage_path,
    sha256: receipt.audio_sha256, bytes: Number(receipt.file_bytes) }));
  if (musicReceipt) files.push({ path: musicReceipt.storage_path,
    sha256: musicReceipt.audio_sha256, bytes: Number(musicReceipt.file_bytes) });
  const signedMedia: Array<{ path: string; url: string }> = [];
  for (const file of files) {
    if (!file.path || !/^[0-9a-f]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.bytes) || file.bytes <= 100
      || file.bytes > MAX_FILE_BYTES) {
      throw new Error("Render media receipt has an invalid size or digest.");
    }
    const stored = await sb.storage.from("client-media").download(file.path);
    if (stored.error || !stored.data) {
      throw new Error("Render media bytes are unavailable.");
    }
    const bytes = Buffer.from(await stored.data.arrayBuffer());
    if (bytes.length !== file.bytes
      || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      throw new Error("Render media bytes differ from the filed receipt.");
    }
    const signed = await sb.storage.from("client-media")
      .createSignedUrl(file.path, 7200);
    if (signed.error || !signed.data?.signedUrl) {
      throw new Error("Render media could not be signed.");
    }
    signedMedia.push({ path: file.path, url: signed.data.signedUrl });
  }
  const timings = renderTimingsFromReceipts({ clientId, projectId,
    irVersion: audioVersion, scenes, receipts,
    musicPath: project.music_path, musicReceipt, signedMedia,
    maxAlignmentLoss: input.maxAlignmentLoss });
  await verifyCompletedAudio(sb, projectId, project.ir_version);
  const final = await sb.from("video_projects")
    .select("stage,ir_version,audio_ir_version,ir,music_path")
    .eq("id", projectId).eq("client_id", clientId).maybeSingle();
  if (final.error || final.data?.stage !== "timed"
    || final.data.ir_version !== project.ir_version
    || final.data.audio_ir_version !== project.audio_ir_version
    || final.data.music_path !== project.music_path
    || JSON.stringify(final.data.ir) !== JSON.stringify(project.ir)) {
    throw new Error("Video IR changed while render inputs were prepared.");
  }
  return { ir, timings, projectId, irVersion: project.ir_version };
}
