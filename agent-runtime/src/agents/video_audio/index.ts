import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { elevenLabsUsd } from "../../usage/cost.js";
import { ElevenLabsHttpError } from "../../video/audio/elevenlabs.js";
import { fileSceneAudio } from "../../video/audio/file-scene.js";
import { finishProjectMusic } from "../../video/audio/project-music.js";
import { elevenLabsSceneDependencies, produceSceneAudio,
  SceneAudioQualityError, type SceneAudio } from "../../video/audio/scene.js";

type Scene = { id: string; project_id: string; client_id: string;
  scene_key: string; narration: string; audio_path: string | null };
type Receipt = { scene_id: string; project_id: string; client_id: string;
  ir_version: number; narration_sha256: string; storage_path: string };
type Produce = (input: { sceneId: string; narration: string;
  maxAlignmentLoss: number; apiKey: string; voiceId: string;
  onSynthesis: (attempt: number) => Promise<void> }) => Promise<SceneAudio>;

function validLoss(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
    && value >= 0 && value <= 1;
}

export async function runVideoAudioJobWithProducer(
  sb: SupabaseClient, config: RuntimeConfig, agent: AgentRow,
  job: AgentJobRow, produce: Produce,
  file: typeof fileSceneAudio = fileSceneAudio,
  finishMusic: typeof finishProjectMusic = finishProjectMusic,
): Promise<JobResult> {
  const params = job.params ?? {};
  if (job.agent_key !== "video_audio" || job.input_table !== "video_scenes"
    || !job.input_id || !job.client_id
    || typeof params.project_id !== "string"
    || !Number.isInteger(params.ir_version) || Number(params.ir_version) < 1
    || typeof params.scene_key !== "string"
    || typeof params.narration_sha256 !== "string") {
    return { ok: false, retryable: false,
      failureMessage: "Video audio job has invalid scene identity." };
  }
  const projectId = params.project_id;
  const irVersion = Number(params.ir_version);
  const [sceneResult, projectResult, receiptResult] = await Promise.all([
    sb.from("video_scenes").select("*")
      .eq("id", job.input_id).eq("client_id", job.client_id).maybeSingle(),
    sb.from("video_projects").select("id,client_id,stage,ir_version")
      .eq("id", projectId).eq("client_id", job.client_id).maybeSingle(),
    sb.from("video_scene_audio_receipts_v1").select("*")
      .eq("scene_id", job.input_id).maybeSingle(),
  ]);
  const scene = sceneResult.data as Scene | null;
  const project = projectResult.data as { id: string; client_id: string;
    stage: string; ir_version: number } | null;
  const receipt = receiptResult.data as Receipt | null;
  if (sceneResult.error || projectResult.error || receiptResult.error
    || !scene || !project || scene.project_id !== projectId
    || scene.client_id !== job.client_id || project.client_id !== job.client_id
    || scene.scene_key !== params.scene_key || project.ir_version !== irVersion
    || !["timing", "timed"].includes(project.stage)
    || createHash("sha256").update(scene.narration).digest("hex")
      !== params.narration_sha256) {
    return { ok: false, retryable: false,
      failureMessage: "Video audio job no longer matches the exact scene." };
  }
  if (receipt) {
    if (receipt.scene_id !== scene.id || receipt.project_id !== projectId
      || receipt.client_id !== job.client_id || receipt.ir_version !== irVersion
      || receipt.narration_sha256 !== params.narration_sha256
      || receipt.storage_path !== scene.audio_path) {
      return { ok: false, retryable: false,
        failureMessage: "Existing video audio receipt does not match the scene." };
    }
    const done = await sb.rpc("complete_video_audio_project_v1", {
      p_project_id: projectId, p_ir_version: irVersion,
    });
    if (done.error) return { ok: false, retryable: false,
      failureMessage: "Stored video audio changed before completion." };
    if (done.data === true) {
      try { await finishMusic({ sb, config, job, projectId, irVersion }); }
      catch { return { ok: false, retryable: false,
        failureMessage: "Video music outcome is unresolved; inspect its attempt." }; }
    }
    return { ok: true, retryable: false };
  }
  if (project.stage !== "timing" || scene.audio_path !== null) {
    return { ok: false, retryable: false,
      failureMessage: "Video audio has an unreceipted scene state." };
  }
  const target = await sb.rpc("video_scene_audio_upload_target_v1", {
    p_project_id: projectId, p_scene_id: scene.id,
  });
  if (target.error || !target.data
    || target.data.narration_sha256 !== params.narration_sha256
    || target.data.ir_version !== irVersion
    || target.data.scene_key !== scene.scene_key) {
    return { ok: false, retryable: false,
      failureMessage: "Video audio source or upload target changed." };
  }
  const exists = await sb.rpc("video_scene_audio_storage_exists_v1", {
    p_project_id: projectId, p_scene_id: scene.id,
  });
  if (exists.error || exists.data !== false) {
    return { ok: false, retryable: false,
      failureMessage: "Video audio file already exists without a receipt or Storage preflight failed." };
  }
  const apiKey = config.elevenLabsApiKey;
  const voiceId = config.elevenLabsVoiceId;
  const maxLoss = agent.config.max_alignment_loss;
  if (!apiKey || !voiceId || !validLoss(maxLoss)) {
    return { ok: false, retryable: false,
      failureMessage: "Video narrator credentials or reviewed alignment policy are unavailable." };
  }
  const begun = await sb.rpc("begin_video_scene_audio_attempt_v1", {
    p_project_id: projectId, p_scene_id: scene.id,
    p_job_id: job.id, p_ir_version: irVersion,
  });
  if (begun.error || begun.data !== true) {
    return { ok: false, retryable: false,
      failureMessage: "Video audio attempt may already have run; reconcile before retry." };
  }
  try {
    const onSynthesis = async (attempt: number): Promise<void> => {
      const units = [...scene.narration].length;
      const cost = await sb.rpc("record_video_scene_speech_cost_v1", {
        p_project_id: projectId, p_scene_id: scene.id, p_job_id: job.id,
        p_ir_version: irVersion, p_attempt: attempt,
        p_units: units, p_usd: elevenLabsUsd(units),
      });
      if (cost.error || typeof cost.data !== "string") {
        throw new Error("Video speech cost could not be recorded after provider success.");
      }
    };
    const audio = await produce({ sceneId: scene.scene_key,
      narration: scene.narration, maxAlignmentLoss: maxLoss,
      apiKey, voiceId, onSynthesis });
    await file({ sb, clientId: job.client_id, projectId,
      sceneId: scene.id, sceneKey: scene.scene_key,
      irVersion, voiceId, audio });
    const done = await sb.rpc("complete_video_audio_project_v1", {
      p_project_id: projectId, p_ir_version: irVersion,
    });
    if (done.error) throw new Error("Audio completion guard failed.");
    if (done.data === true) await finishMusic({ sb, config, job, projectId, irVersion });
    return { ok: true, retryable: false };
  } catch (error) {
    if (error instanceof ElevenLabsHttpError && error.retryable) {
      // A provider error can occur after charging for an earlier request in
      // this two-request stage. Do not retry blindly until usage is reconciled.
      return { ok: false, retryable: false,
        failureMessage: "Video audio provider failed; reconcile usage before retry." };
    }
    if (error instanceof SceneAudioQualityError) {
      return { ok: false, retryable: false,
        failureMessage: "Video audio alignment failed its reviewed quality policy." };
    }
    return { ok: false, retryable: false,
      failureMessage: "Video audio failed; inspect Storage and provider usage before retry." };
  }
}

export async function runVideoAudioJob(sb: SupabaseClient, config: RuntimeConfig,
  agent: AgentRow, job: AgentJobRow): Promise<JobResult> {
  return runVideoAudioJobWithProducer(sb, config, agent, job,
    ({ sceneId, narration, maxAlignmentLoss, apiKey, voiceId, onSynthesis }) =>
      produceSceneAudio({ sceneId, narration, maxAlignmentLoss },
        { ...elevenLabsSceneDependencies(apiKey, voiceId), onSynthesis }));
}
