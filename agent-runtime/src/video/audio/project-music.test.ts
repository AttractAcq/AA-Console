import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../../config.js";
import type { AgentJobRow } from "../../queue.js";
import { ElevenLabsHttpError } from "./elevenlabs.js";
import { fileMusicBed, finishProjectMusic,
  videoDurationFromScenes } from "./project-music.js";
import type { MusicBed } from "./music.js";

const clientId = "f2222222-2222-4222-8222-222222222222";
const projectId = "f3333333-3333-4333-8333-333333333333";
const jobId = "f5555555-5555-4555-8555-555555555555";
const objectId = "f6666666-6666-4666-8666-666666666666";
const path = `${clientId}/video/projects/${projectId}/ir-v1/music.mp3`;
const job = { id: jobId, client_id: clientId, agent_key: "video_audio",
  input_table: "video_scenes", input_id: objectId,
  params: { project_id: projectId, ir_version: 1 },
  status: "running", attempts: 1, max_attempts: 3,
  lease_owner: "worker-1", lease_until: null } satisfies AgentJobRow;
const config = { elevenLabsApiKey: "managed-test-key",
  elevenLabsMusicEnabled: true } as RuntimeConfig;
const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(128, 1)]);
const prompt = "instrumental, no vocals, warm piano, calm, loopable, suitable for an educational explainer";
const bed = { mp3, sha256: createHash("sha256").update(mp3).digest("hex"),
  songId: "song-1", modelId: "music_v2_5", requestedLengthMs: 14_000,
  durationSec: 14, measuredLufs: -24, loopRequired: false,
  prompt } satisfies MusicBed;
const scenes = [1, 2, 3].map((position) => ({
  scene_key: `s0${position}`, duration_sec: 4, min_duration_sec: null,
  transition_in: "cut",
}));

function projectDb(options: { state?: string; musicEnabled?: boolean;
  providerError?: boolean; costError?: boolean } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const project = { id: projectId, client_id: clientId, stage: "timing",
    ir_version: 1, tone: "calm",
    ir: { music: { enabled: options.musicEnabled ?? true, mood: "warm piano" },
      scenes: [1, 2, 3] } };
  const sb = {
    from: (name: string) => {
      const query = { select: () => query, eq: () => query,
        maybeSingle: async () => ({ data: project, error: null }),
        order: async () => ({ data: name === "video_scenes" ? scenes : null,
          error: null }) };
      return query;
    },
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "begin_video_project_music_v1") {
        return { data: { state: options.state ?? "started" }, error: null };
      }
      if (name === "video_project_music_storage_exists_v1") {
        return { data: false, error: null };
      }
      if (name === "record_video_project_music_cost_v1") {
        return options.costError ? { data: null, error: { message: "held" } }
          : { data: objectId, error: null };
      }
      if (name === "fail_video_project_music_v1"
        || name === "complete_video_audio_project_v1") {
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    }),
  } as unknown as SupabaseClient;
  return { sb, calls };
}

describe("project-level optional music", () => {
  it("uses scene audio frame lengths and transition overlap", () => {
    expect(videoDurationFromScenes(scenes)).toBe(12);
    expect(videoDurationFromScenes(scenes.map((scene, index) =>
      index === 1 ? { ...scene, transition_in: "fade" } : scene))).toBe(11.4);
    expect(() => videoDurationFromScenes(scenes.slice(0, 2))).toThrow();
  });
  it("records a disabled request as skipped and advances without a provider call", async () => {
    const { sb, calls } = projectDb({ state: "skipped" });
    const prepare = vi.fn();
    await finishProjectMusic({ sb, config: { ...config,
      elevenLabsMusicEnabled: false }, job, projectId, irVersion: 1,
      prepare });
    expect(prepare).not.toHaveBeenCalled();
    expect(calls.map((call) => call.name)).toEqual([
      "begin_video_project_music_v1", "complete_video_audio_project_v1"]);
    expect(calls[0]?.args).toMatchObject({ p_enabled: false,
      p_prompt: null, p_requested_ms: null });
  });
  it("records the charge after composition, files exact bytes, then advances", async () => {
    const { sb, calls } = projectDb();
    const prepare = vi.fn(async (input: { onComposition?: (value: MusicBed) => Promise<void> }) => {
      await input.onComposition?.(bed);
      return bed;
    });
    const file = vi.fn().mockResolvedValue(path);
    await finishProjectMusic({ sb, config, job, projectId, irVersion: 1,
      prepare: prepare as typeof import("./music.js").prepareMusicBed,
      file });
    expect(calls.map((call) => call.name)).toEqual([
      "begin_video_project_music_v1",
      "video_project_music_storage_exists_v1",
      "record_video_project_music_cost_v1",
      "complete_video_audio_project_v1"]);
    expect(calls[2]?.args).toMatchObject({ p_requested_ms: 14_000,
      p_usd: 0.035 });
    expect(file).toHaveBeenCalledWith(expect.objectContaining({
      clientId, projectId, irVersion: 1, jobId, bed }));
  });
  it("keeps a concurrent attempt from making another paid request", async () => {
    const { sb, calls } = projectDb({ state: "already_started" });
    const prepare = vi.fn();
    await finishProjectMusic({ sb, config, job, projectId, irVersion: 1,
      prepare });
    expect(prepare).not.toHaveBeenCalled();
    expect(calls.map((call) => call.name)).toEqual(["begin_video_project_music_v1"]);
  });
  it("records provider and cost failures and completes narration-only", async () => {
    const provider = projectDb();
    await finishProjectMusic({ sb: provider.sb, config, job,
      projectId, irVersion: 1,
      prepare: vi.fn().mockRejectedValue(new ElevenLabsHttpError(429, "Music")) });
    expect(provider.calls.find((call) => call.name === "fail_video_project_music_v1")?.args)
      .toMatchObject({ p_code: "provider" });
    const cost = projectDb({ costError: true });
    const prepare = vi.fn(async (input: { onComposition?: (value: MusicBed) => Promise<void> }) => {
      await input.onComposition?.(bed);
      return bed;
    });
    const file = vi.fn();
    await finishProjectMusic({ sb: cost.sb, config, job, projectId,
      irVersion: 1,
      prepare: prepare as typeof import("./music.js").prepareMusicBed,
      file });
    expect(cost.calls.find((call) => call.name === "fail_video_project_music_v1")?.args)
      .toMatchObject({ p_code: "cost" });
    expect(file).not.toHaveBeenCalled();
  });
  it("checks uploaded bytes and immutable Storage identity before commit", async () => {
    const identity = { client_id: clientId, project_id: projectId,
      ir_version: 1, storage_path: path, object_id: objectId,
      object_version: "v1", object_updated_at: "2026-11-20T00:00:00Z" };
    let stored: Buffer = mp3;
    const rpc = vi.fn(async (name: string) => name === "commit_video_project_music_v1"
      ? { data: projectId, error: null }
      : { data: identity, error: null });
    const sb = { rpc, storage: { from: () => ({
      upload: vi.fn(async (_path: string, bytes: Buffer) => {
        stored = bytes; return { data: { path }, error: null };
      }),
      download: vi.fn(async () => ({ data: new Blob([new Uint8Array(stored)]),
        error: null })),
    }) } } as unknown as SupabaseClient;
    expect(await fileMusicBed({ sb, clientId, projectId, irVersion: 1,
      jobId, bed })).toBe(path);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "video_project_music_storage_identity_v1",
      "video_project_music_storage_identity_v1",
      "commit_video_project_music_v1"]);
    const tampered = { ...sb, storage: { from: () => ({
      upload: vi.fn().mockResolvedValue({ data: {}, error: null }),
      download: vi.fn().mockResolvedValue({ data: new Blob([Uint8Array.from(mp3).fill(2)]),
        error: null }),
    }) } } as unknown as SupabaseClient;
    await expect(fileMusicBed({ sb: tampered, clientId, projectId,
      irVersion: 1, jobId, bed })).rejects.toThrow(/differ/);
  });
});
