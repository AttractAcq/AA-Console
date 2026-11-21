import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentJobRow } from "../../queue.js";
import { elevenMusicUsd } from "../../usage/cost.js";
import { ElevenLabsHttpError } from "./elevenlabs.js";
import { musicLengthMs, musicPrompt, prepareMusicBed,
  type MusicBed } from "./music.js";

type Project = { id: string; client_id: string; stage: string;
  ir_version: number; ir: unknown; tone: string };
type Scene = { scene_key: string; duration_sec: number;
  min_duration_sec: number | null; transition_in: string };
type Identity = { client_id: string; project_id: string; ir_version: number;
  storage_path: string; object_id: string; object_version: string | null;
  object_updated_at: string };
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function videoDurationFromScenes(scenes: Scene[]): number {
  if (scenes.length < 3 || scenes.length > 40) {
    throw new Error("Music timing needs three to forty completed scenes.");
  }
  let frames = 0;
  scenes.forEach((scene, index) => {
    if (scene.scene_key !== `s${String(index + 1).padStart(2, "0")}`
      || !Number.isFinite(Number(scene.duration_sec))
      || Number(scene.duration_sec) <= 0 || Number(scene.duration_sec) > 25
      || (scene.min_duration_sec !== null
        && (!Number.isFinite(Number(scene.min_duration_sec))
          || Number(scene.min_duration_sec) < 2 || Number(scene.min_duration_sec) > 25))) {
      throw new Error("Music timing scene order or duration is invalid.");
    }
    if (index > 0 && scene.transition_in !== "cut") frames -= 18;
    frames += Math.max(Math.ceil(Number(scene.duration_sec) * 30),
      Math.ceil(Number(scene.min_duration_sec ?? 2) * 30));
  });
  const seconds = frames / 30;
  if (seconds < 3 || seconds > 900) {
    throw new Error("Music timing is outside the video length limit.");
  }
  return seconds;
}

function currentIdentity(value: unknown, input: { clientId: string;
  projectId: string; irVersion: number; path: string }): Identity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Music Storage identity is unavailable.");
  }
  const row = value as Record<string, unknown>;
  if (row.client_id !== input.clientId || row.project_id !== input.projectId
    || row.ir_version !== input.irVersion || row.storage_path !== input.path
    || typeof row.object_id !== "string" || !UUID.test(row.object_id)
    || (row.object_version !== null && typeof row.object_version !== "string")
    || typeof row.object_updated_at !== "string"
    || Number.isNaN(Date.parse(row.object_updated_at))) {
    throw new Error("Music Storage identity does not match the current IR.");
  }
  return row as Identity;
}

/** Verify stored bytes and object identity before binding the bed to the IR. */
export async function fileMusicBed(input: { sb: SupabaseClient;
  clientId: string; projectId: string; irVersion: number;
  jobId: string; bed: MusicBed }): Promise<string> {
  const { sb, bed } = input;
  if (![input.clientId, input.projectId, input.jobId].every((id) => UUID.test(id))
    || !Number.isInteger(input.irVersion) || input.irVersion < 1
    || !Buffer.isBuffer(bed.mp3) || bed.mp3.length <= 100
    || !HASH.test(bed.sha256)
    || createHash("sha256").update(bed.mp3).digest("hex") !== bed.sha256
    || !Number.isFinite(bed.durationSec) || bed.durationSec < 3
    || bed.durationSec > 301 || !Number.isFinite(bed.measuredLufs)
    || Math.abs(bed.measuredLufs + 24) > 1
    || !bed.prompt.trim() || bed.requestedLengthMs < 3000
    || bed.requestedLengthMs > 300000 || bed.modelId !== "music_v2_5"
    || (bed.songId !== null && bed.songId.length > 200)) {
    throw new Error("Music bed is invalid before Storage filing.");
  }
  const path = `${input.clientId}/video/projects/${input.projectId}`
    + `/ir-v${input.irVersion}/music.mp3`;
  const upload = await sb.storage.from("client-media").upload(path, bed.mp3, {
    contentType: "audio/mpeg", upsert: false,
  });
  if (upload.error) throw new Error("Music Storage upload failed.");
  const firstResult = await sb.rpc("video_project_music_storage_identity_v1", {
    p_project_id: input.projectId, p_ir_version: input.irVersion,
  });
  if (firstResult.error) throw new Error("Music Storage identity could not be read.");
  const expected = { clientId: input.clientId, projectId: input.projectId,
    irVersion: input.irVersion, path };
  const first = currentIdentity(firstResult.data, expected);
  const download = await sb.storage.from("client-media").download(path);
  if (download.error || !download.data) {
    throw new Error("Music Storage bytes could not be downloaded.");
  }
  const bytes = Buffer.from(await download.data.arrayBuffer());
  if (bytes.length !== bed.mp3.length
    || createHash("sha256").update(bytes).digest("hex") !== bed.sha256) {
    throw new Error("Music Storage bytes differ from the generated bed.");
  }
  const secondResult = await sb.rpc("video_project_music_storage_identity_v1", {
    p_project_id: input.projectId, p_ir_version: input.irVersion,
  });
  if (secondResult.error) throw new Error("Music Storage identity changed.");
  const second = currentIdentity(secondResult.data, expected);
  if (first.object_id !== second.object_id
    || first.object_version !== second.object_version
    || first.object_updated_at !== second.object_updated_at) {
    throw new Error("Music Storage object changed during verification.");
  }
  const commit = await sb.rpc("commit_video_project_music_v1", {
    p_project_id: input.projectId, p_job_id: input.jobId,
    p_ir_version: input.irVersion, p_storage_path: path,
    p_audio_sha256: bed.sha256, p_file_bytes: bytes.length,
    p_object_id: first.object_id, p_object_version: first.object_version,
    p_object_updated_at: first.object_updated_at,
    p_duration_sec: Math.round(bed.durationSec * 100) / 100,
    p_measured_lufs: Math.round(bed.measuredLufs * 100) / 100,
    p_prompt: bed.prompt, p_song_id: bed.songId,
    p_requested_ms: bed.requestedLengthMs,
  });
  if (commit.error || commit.data !== input.projectId) {
    throw new Error("Verified music could not be committed.");
  }
  return path;
}

class MusicCostError extends Error {}

/** Only the scene job that wins the project attempt may call Eleven Music. */
export async function finishProjectMusic(input: {
  sb: SupabaseClient; config: RuntimeConfig; job: AgentJobRow;
  projectId: string; irVersion: number;
  prepare?: typeof prepareMusicBed; file?: typeof fileMusicBed;
}): Promise<void> {
  const { sb, job, projectId, irVersion } = input;
  const [projectResult, scenesResult] = await Promise.all([
    sb.from("video_projects").select("id,client_id,stage,ir_version,ir,tone")
      .eq("id", projectId).eq("client_id", job.client_id).maybeSingle(),
    sb.from("video_scenes").select("scene_key,duration_sec,min_duration_sec,transition_in")
      .eq("project_id", projectId).eq("client_id", job.client_id)
      .order("position"),
  ]);
  const project = projectResult.data as Project | null;
  if (projectResult.error || scenesResult.error || !project
    || project.id !== projectId || project.client_id !== job.client_id
    || project.ir_version !== irVersion
    || !["timing", "timed"].includes(project.stage)
    || !project.ir || typeof project.ir !== "object"
    || !Array.isArray((project.ir as Record<string, unknown>).scenes)) {
    throw new Error("Music project is no longer in exact timing state.");
  }
  const ir = project.ir as { music?: { enabled?: boolean; mood?: string };
    scenes: unknown[] };
  const queueRender = async (): Promise<void> => {
    const queued = await sb.rpc("queue_video_render_v1", {
      p_project_id: projectId, p_ir_version: irVersion,
    });
    if (queued.error || typeof queued.data !== "string") {
      throw new Error("Timed video could not queue its exact render job.");
    }
  };
  if (project.stage === "timed") {
    await queueRender();
    return;
  }
  const scenes = scenesResult.data as Scene[] | null;
  if (!scenes || ir.scenes.length !== scenes.length
    || typeof ir.music?.enabled !== "boolean") {
    throw new Error("Music IR and completed scenes differ.");
  }
  const requested = ir.music.enabled;
  const enabled = input.config.elevenLabsMusicEnabled === true;
  const duration = videoDurationFromScenes(scenes);
  const prompt = requested && enabled
    ? musicPrompt(ir.music.mood?.trim() || "neutral", project.tone) : null;
  const requestedLengthMs = requested && enabled ? musicLengthMs(duration) : null;
  const begun = await sb.rpc("begin_video_project_music_v1", {
    p_project_id: projectId, p_job_id: job.id,
    p_ir_version: irVersion, p_enabled: enabled,
    p_prompt: prompt, p_requested_ms: requestedLengthMs,
  });
  if (begun.error || !begun.data || typeof begun.data.state !== "string") {
    throw new Error("Music attempt could not be bound to the exact project.");
  }
  const state = begun.data.state as string;
  if (state === "already_started") return;
  const complete = async (): Promise<void> => {
    const done = await sb.rpc("complete_video_audio_project_v1", {
      p_project_id: projectId, p_ir_version: irVersion,
    });
    if (done.error || done.data !== true) {
      throw new Error("Music outcome could not advance verified scene audio.");
    }
    await queueRender();
  };
  if (state === "skipped" || state === "already_filed"
    || state === "already_failed" || state === "already_skipped") {
    await complete();
    return;
  }
  if (state !== "started" || prompt === null || requestedLengthMs === null) {
    throw new Error("Music attempt returned an invalid state.");
  }
  const fail = async (code: string): Promise<void> => {
    const result = await sb.rpc("fail_video_project_music_v1", {
      p_project_id: projectId, p_job_id: job.id,
      p_ir_version: irVersion, p_code: code,
    });
    if (result.error || result.data !== true) {
      throw new Error("Music failure could not be recorded.");
    }
    await complete();
  };
  const exists = await sb.rpc("video_project_music_storage_exists_v1", {
    p_project_id: projectId, p_ir_version: irVersion,
  });
  if (exists.error || exists.data !== false) {
    await fail("storage");
    return;
  }
  if (!input.config.elevenLabsApiKey) {
    await fail("credentials");
    return;
  }
  let bed: MusicBed;
  try {
    bed = await (input.prepare ?? prepareMusicBed)({
      apiKey: input.config.elevenLabsApiKey,
      mood: ir.music.mood?.trim() || "neutral", tone: project.tone,
      videoDurationSec: duration,
      onComposition: async (composed) => {
        if (composed.requestedLengthMs !== requestedLengthMs) {
          throw new MusicCostError("Music request length changed after preflight.");
        }
        const cost = await sb.rpc("record_video_project_music_cost_v1", {
          p_project_id: projectId, p_job_id: job.id,
          p_ir_version: irVersion, p_requested_ms: requestedLengthMs,
          p_usd: elevenMusicUsd(requestedLengthMs / 1000),
        });
        if (cost.error || typeof cost.data !== "string") {
          throw new MusicCostError("Music cost receipt is unavailable.");
        }
      },
    });
  } catch (error) {
    const providerError = error instanceof ElevenLabsHttpError
      || (error instanceof Error && ["AbortError", "TimeoutError", "TypeError"]
        .includes(error.name));
    await fail(error instanceof MusicCostError ? "cost"
      : providerError ? "provider" : "invalid_media");
    return;
  }
  try {
    if (bed.requestedLengthMs !== requestedLengthMs
      || bed.prompt !== prompt) throw new Error("Music source changed.");
    await (input.file ?? fileMusicBed)({ sb, clientId: job.client_id,
      projectId, irVersion, jobId: job.id, bed });
  } catch {
    await fail("storage");
    return;
  }
  await complete();
}
