import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { fileSceneAudio } from "./file-scene.js";

const clientId = "f2222222-2222-4222-8222-222222222222";
const projectId = "f3333333-3333-4333-8333-333333333333";
const sceneId = "f4444444-4444-4444-8444-444444444444";
const path = `${clientId}/video/projects/${projectId}/ir-v1/scenes/s01/audio.mp3`;
const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(256, 17)]);
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const audio = { mp3, alignment: { loss: 0.05, words: [
  { text: "Hello.", startSec: 0.1, endSec: 2.1, loss: 0.05 },
] }, durationSec: 2.2, measuredLufs: -16, attempts: 1,
  narrationSha256: digest("Hello."), audioSha256: digest(mp3) };
const identity = { client_id: clientId, project_id: projectId,
  scene_id: sceneId, ir_version: 1, scene_key: "s01",
  narration_sha256: digest("Hello."), storage_path: path,
  object_id: "f5555555-5555-4555-8555-555555555555",
  object_version: "v1", object_updated_at: "2026-11-20T00:00:00Z" };

function fixture(opts: { stored?: Buffer; identities?: unknown[];
  uploadError?: boolean; target?: unknown } = {}) {
  const upload = vi.fn().mockResolvedValue({ data: null,
    error: opts.uploadError ? { message: "duplicate" } : null });
  const download = vi.fn().mockResolvedValue({
    data: new Blob([Uint8Array.from(opts.stored ?? mp3)]), error: null,
  });
  const calls: string[] = [];
  const queue = [...(opts.identities ?? [identity, identity])];
  const rpc = vi.fn(async (name: string, _args?: Record<string, unknown>) => {
    calls.push(name);
    return name === "video_scene_audio_upload_target_v1"
      ? { data: opts.target ?? identity, error: null }
      : name === "video_scene_audio_storage_identity_v1"
      ? { data: queue.shift(), error: null }
      : { data: sceneId, error: null };
  });
  const sb = { storage: { from: vi.fn().mockReturnValue({ upload, download }) },
    rpc } as unknown as SupabaseClient;
  return { sb, upload, download, rpc, calls };
}

const input = { clientId, projectId, sceneId, sceneKey: "s01",
  irVersion: 1, voiceId: "narrator-1", audio };

describe("exact scene audio filing", () => {
  it("verifies the stored bytes and unchanged object before committing", async () => {
    const f = fixture();
    await expect(fileSceneAudio({ sb: f.sb, ...input })).resolves.toBe(path);
    expect(f.upload).toHaveBeenCalledWith(path, mp3,
      { contentType: "audio/mpeg", upsert: false });
    expect(f.calls).toEqual(["video_scene_audio_upload_target_v1",
      "video_scene_audio_storage_identity_v1",
      "video_scene_audio_storage_identity_v1", "commit_video_scene_audio_v1"]);
    expect(f.rpc.mock.calls[3]?.[1]).toMatchObject({
      p_audio_sha256: digest(mp3), p_file_bytes: mp3.length,
      p_object_id: identity.object_id, p_ir_version: 1,
    });
  });
  it("accepts a retry only when the existing object has identical bytes", async () => {
    const same = fixture({ uploadError: true });
    await expect(fileSceneAudio({ sb: same.sb, ...input })).resolves.toBe(path);
    const changed = fixture({ uploadError: true, stored: Buffer.alloc(mp3.length, 7) });
    await expect(fileSceneAudio({ sb: changed.sb, ...input }))
      .rejects.toThrow(/differs/);
    expect(changed.calls).not.toContain("commit_video_scene_audio_v1");
  });
  it("holds a changed scene or Storage object before the commit", async () => {
    const changedScene = fixture({ target: { ...identity, ir_version: 2 } });
    await expect(fileSceneAudio({ sb: changedScene.sb, ...input }))
      .rejects.toThrow(/current scene/);
    expect(changedScene.upload).not.toHaveBeenCalled();
    const replaced = fixture({ identities: [identity,
      { ...identity, object_version: "v2" }] });
    await expect(fileSceneAudio({ sb: replaced.sb, ...input }))
      .rejects.toThrow(/changed during verification/);
    expect(replaced.calls).not.toContain("commit_video_scene_audio_v1");
  });
  it("rejects a forged generated hash before Storage access", async () => {
    const f = fixture();
    await expect(fileSceneAudio({ sb: f.sb, ...input,
      audio: { ...audio, audioSha256: digest("other") } }))
      .rejects.toThrow(/inputs are invalid/);
    expect(f.upload).not.toHaveBeenCalled();
  });
});
