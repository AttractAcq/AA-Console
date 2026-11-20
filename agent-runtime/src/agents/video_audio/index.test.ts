import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { AgentJobRow } from "../../queue.js";
import type { SceneAudio } from "../../video/audio/scene.js";
import { runVideoAudioJobWithProducer } from "./index.js";

const clientId = "f2222222-2222-4222-8222-222222222222";
const projectId = "f3333333-3333-4333-8333-333333333333";
const sceneId = "f4444444-4444-4444-8444-444444444444";
const narration = "Explain the service.";
const narrationSha256 = createHash("sha256").update(narration).digest("hex");
const path = `${clientId}/video/projects/${projectId}/ir-v1/scenes/s01/audio.mp3`;
const job = { id: "f5555555-5555-4555-8555-555555555555",
  agent_key: "video_audio", client_id: clientId,
  input_table: "video_scenes", input_id: sceneId,
  params: { project_id: projectId, ir_version: 1,
    scene_key: "s01", narration_sha256: narrationSha256 },
  status: "running", attempts: 1, max_attempts: 3,
  lease_owner: "worker-1", lease_until: null } satisfies AgentJobRow;
const agent = { agent_key: "video_audio", name: "Video audio", initials: "VA",
  domain: "content_production", description: null, requires_upstream: [],
  paused: true, config: { max_alignment_loss: 0.25 } } satisfies AgentRow;
const config = { elevenLabsApiKey: "managed-test-key",
  elevenLabsVoiceId: "fixed-voice" } as RuntimeConfig;
const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(128, 1)]);
const audio = { mp3, alignment: { loss: 0.1, words: [{
  text: "Explain", startSec: 0.1, endSec: 0.6, loss: 0.1,
}] }, durationSec: 2.1, measuredLufs: -16, attempts: 1,
  narrationSha256, audioSha256: createHash("sha256").update(mp3).digest("hex") } satisfies SceneAudio;

function fixture(options: { scene?: Record<string, unknown>;
  project?: Record<string, unknown>; receipt?: Record<string, unknown> | null;
  exists?: boolean; rpcError?: string } = {}) {
  const scene = { id: sceneId, project_id: projectId, client_id: clientId,
    scene_key: "s01", narration, audio_path: null, ...options.scene };
  const project = { id: projectId, client_id: clientId,
    stage: "timing", ir_version: 1, ...options.project };
  const receipt = options.receipt ?? null;
  const calls: string[] = [];
  const sb = {
    from: (name: string) => {
      const query = { select: () => query, eq: () => query,
        maybeSingle: async () => ({ data: name === "video_scenes" ? scene
          : name === "video_projects" ? project : receipt, error: null }) };
      return query;
    },
    rpc: vi.fn(async (name: string) => {
      calls.push(name);
      if (options.rpcError === name) return { data: null, error: { message: "held" } };
      if (name === "video_scene_audio_upload_target_v1") {
        return { data: { ir_version: 1, scene_key: "s01",
          narration_sha256: narrationSha256, storage_path: path }, error: null };
      }
      if (name === "video_scene_audio_storage_exists_v1") {
        return { data: options.exists ?? false, error: null };
      }
      if (name === "begin_video_scene_audio_attempt_v1") {
        return { data: true, error: null };
      }
      if (name === "complete_video_audio_project_v1") {
        return { data: false, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    }),
  } as unknown as SupabaseClient;
  return { sb, calls };
}

describe("paused-by-default scene audio worker contract", () => {
  it("produces and files only an exact, absent scene then checks project completion", async () => {
    const { sb, calls } = fixture();
    const produce = vi.fn().mockResolvedValue(audio);
    const file = vi.fn().mockResolvedValue(path);
    const result = await runVideoAudioJobWithProducer(sb, config, agent,
      job, produce, file);
    expect(result).toMatchObject({ ok: true, retryable: false });
    expect(produce).toHaveBeenCalledWith({ sceneId: "s01", narration,
      maxAlignmentLoss: 0.25, apiKey: "managed-test-key", voiceId: "fixed-voice" });
    expect(file).toHaveBeenCalledWith(expect.objectContaining({
      sceneId, projectId, irVersion: 1, voiceId: "fixed-voice", audio }));
    expect(calls).toEqual(["video_scene_audio_upload_target_v1",
      "video_scene_audio_storage_exists_v1",
      "begin_video_scene_audio_attempt_v1", "complete_video_audio_project_v1"]);
  });
  it("does not make a second provider call for an exact filed receipt", async () => {
    const { sb, calls } = fixture({ scene: { audio_path: path }, receipt: {
      scene_id: sceneId, project_id: projectId, client_id: clientId,
      ir_version: 1, narration_sha256: narrationSha256, storage_path: path,
    } });
    const produce = vi.fn();
    expect(await runVideoAudioJobWithProducer(sb, config, agent,
      job, produce, vi.fn())).toMatchObject({ ok: true });
    expect(produce).not.toHaveBeenCalled();
    expect(calls).toEqual(["complete_video_audio_project_v1"]);
  });
  it("holds stale scene identity and an orphaned Storage file before spending", async () => {
    const produce = vi.fn();
    const stale = fixture({ project: { ir_version: 2 } });
    expect(await runVideoAudioJobWithProducer(stale.sb, config, agent,
      job, produce, vi.fn())).toMatchObject({ ok: false, retryable: false });
    const orphan = fixture({ exists: true });
    expect(await runVideoAudioJobWithProducer(orphan.sb, config, agent,
      job, produce, vi.fn())).toMatchObject({ ok: false, retryable: false,
        failureMessage: expect.stringContaining("without a receipt") });
    expect(produce).not.toHaveBeenCalled();
  });
  it("requires managed narrator and an explicit reviewed loss policy", async () => {
    const produce = vi.fn();
    const { sb } = fixture();
    const result = await runVideoAudioJobWithProducer(sb,
      { ...config, elevenLabsVoiceId: null }, agent, job, produce, vi.fn());
    expect(result).toMatchObject({ ok: false, retryable: false });
    const noPolicy = await runVideoAudioJobWithProducer(sb, config,
      { ...agent, config: {} }, job, produce, vi.fn());
    expect(noPolicy).toMatchObject({ ok: false, retryable: false });
    expect(produce).not.toHaveBeenCalled();
  });
  it("never calls the provider when a prior attempt is unresolved", async () => {
    const { sb, calls } = fixture({
      rpcError: "begin_video_scene_audio_attempt_v1" });
    const produce = vi.fn();
    expect(await runVideoAudioJobWithProducer(sb, config, agent,
      job, produce, vi.fn())).toMatchObject({ ok: false, retryable: false,
        failureMessage: expect.stringContaining("reconcile before retry") });
    expect(produce).not.toHaveBeenCalled();
    expect(calls).toContain("begin_video_scene_audio_attempt_v1");
  });
});
