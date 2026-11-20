import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SceneAudio } from "./scene.js";

type Identity = {
  client_id: string; project_id: string; scene_id: string;
  ir_version: number; scene_key: string; narration_sha256: string;
  storage_path: string; object_id: string; object_version: string | null;
  object_updated_at: string;
};
type Target = Omit<Identity, "object_id" | "object_version" | "object_updated_at">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;

function isIdentity(value: unknown): value is Identity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return [v.client_id, v.project_id, v.scene_id, v.object_id]
    .every((item) => typeof item === "string" && UUID.test(item))
    && Number.isInteger(v.ir_version) && Number(v.ir_version) > 0
    && typeof v.scene_key === "string" && /^s\d{2}$/.test(v.scene_key)
    && typeof v.narration_sha256 === "string" && HASH.test(v.narration_sha256)
    && typeof v.storage_path === "string" && v.storage_path.length > 0
    && (v.object_version === null || typeof v.object_version === "string")
    && typeof v.object_updated_at === "string" && !Number.isNaN(Date.parse(v.object_updated_at));
}

function sameIdentity(a: Identity, b: Identity): boolean {
  return a.client_id === b.client_id && a.project_id === b.project_id
    && a.scene_id === b.scene_id && a.ir_version === b.ir_version
    && a.scene_key === b.scene_key && a.narration_sha256 === b.narration_sha256
    && a.storage_path === b.storage_path && a.object_id === b.object_id
    && a.object_version === b.object_version
    && a.object_updated_at === b.object_updated_at;
}

function isTarget(value: unknown): value is Target {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return [v.client_id, v.project_id, v.scene_id]
    .every((item) => typeof item === "string" && UUID.test(item))
    && Number.isInteger(v.ir_version) && Number(v.ir_version) > 0
    && typeof v.scene_key === "string" && /^s\d{2}$/.test(v.scene_key)
    && typeof v.narration_sha256 === "string" && HASH.test(v.narration_sha256)
    && typeof v.storage_path === "string" && v.storage_path.length > 0;
}

async function identity(sb: SupabaseClient, projectId: string, sceneId: string): Promise<Identity> {
  const result = await sb.rpc("video_scene_audio_storage_identity_v1", {
    p_project_id: projectId, p_scene_id: sceneId,
  });
  if (result.error || !isIdentity(result.data)) {
    throw new Error("Current video scene audio Storage identity is unavailable.");
  }
  return result.data;
}

/** File generated audio once, then attest the downloaded bytes and exact scene. */
export async function fileSceneAudio(input: {
  sb: SupabaseClient; clientId: string; projectId: string; sceneId: string;
  sceneKey: string; irVersion: number; voiceId: string; audio: SceneAudio;
}): Promise<string> {
  const { sb, audio } = input;
  if (![input.clientId, input.projectId, input.sceneId].every((id) => UUID.test(id))
    || !/^s\d{2}$/.test(input.sceneKey) || !Number.isInteger(input.irVersion)
    || input.irVersion < 1 || !input.voiceId.trim() || input.voiceId.length > 100
    || !Buffer.isBuffer(audio.mp3) || audio.mp3.length <= 100
    || !HASH.test(audio.audioSha256) || !HASH.test(audio.narrationSha256)
    || createHash("sha256").update(audio.mp3).digest("hex") !== audio.audioSha256
    || !Number.isFinite(audio.durationSec) || !Number.isFinite(audio.measuredLufs)
    || !Number.isFinite(audio.alignment?.loss)
    || audio.alignment.loss < 0 || !Array.isArray(audio.alignment.words)
    || audio.alignment.words.length === 0) {
    throw new Error("Video audio filing inputs are invalid.");
  }
  const path = `${input.clientId}/video/projects/${input.projectId}`
    + `/ir-v${input.irVersion}/scenes/${input.sceneKey}/audio.mp3`;
  const target = await sb.rpc("video_scene_audio_upload_target_v1", {
    p_project_id: input.projectId, p_scene_id: input.sceneId,
  });
  if (target.error || !isTarget(target.data)
    || target.data.client_id !== input.clientId
    || target.data.project_id !== input.projectId
    || target.data.scene_id !== input.sceneId
    || target.data.ir_version !== input.irVersion
    || target.data.scene_key !== input.sceneKey
    || target.data.storage_path !== path
    || target.data.narration_sha256 !== audio.narrationSha256) {
    throw new Error("Video audio does not match the current scene target.");
  }
  // An existing object may be a retry. Never overwrite it; verify its bytes.
  await sb.storage.from("client-media").upload(path, audio.mp3, {
    contentType: "audio/mpeg", upsert: false,
  });
  const first = await identity(sb, input.projectId, input.sceneId);
  if (first.client_id !== input.clientId || first.project_id !== input.projectId
    || first.scene_id !== input.sceneId || first.scene_key !== input.sceneKey
    || first.ir_version !== input.irVersion || first.storage_path !== path
    || first.narration_sha256 !== audio.narrationSha256) {
    throw new Error("Video audio no longer matches the current scene.");
  }
  const file = await sb.storage.from("client-media").download(path);
  if (file.error || !file.data) throw new Error("Stored video audio could not be downloaded.");
  const bytes = Buffer.from(await file.data.arrayBuffer());
  if (bytes.length !== audio.mp3.length
    || createHash("sha256").update(bytes).digest("hex") !== audio.audioSha256) {
    throw new Error("Stored video audio differs from the generated audio.");
  }
  const second = await identity(sb, input.projectId, input.sceneId);
  if (!sameIdentity(first, second)) {
    throw new Error("Video audio Storage identity changed during verification.");
  }
  const result = await sb.rpc("commit_video_scene_audio_v1", {
    p_project_id: input.projectId, p_scene_id: input.sceneId,
    p_ir_version: input.irVersion,
    p_narration_sha256: audio.narrationSha256,
    p_audio_sha256: audio.audioSha256,
    p_storage_path: path, p_file_bytes: bytes.length,
    p_object_id: first.object_id, p_object_version: first.object_version,
    p_object_updated_at: first.object_updated_at,
    p_alignment: audio.alignment.words,
    p_alignment_loss: Math.round(audio.alignment.loss * 10_000) / 10_000,
    p_duration_sec: Math.round(audio.durationSec * 100) / 100,
    p_measured_lufs: Math.round(audio.measuredLufs * 100) / 100,
    p_voice_id: input.voiceId, p_attempts: audio.attempts,
  });
  if (result.error || result.data !== input.sceneId) {
    throw new Error("Verified video audio could not be committed to its scene.");
  }
  return path;
}
