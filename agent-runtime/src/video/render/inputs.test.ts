import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { buildVideoRenderInputs } from "./inputs.js";

const ir = JSON.parse(readFileSync(resolve(import.meta.dirname,
  "../../../../video-render/fixtures/ir/three-scene-v2.json"), "utf8"));
const clientId = "client";
const projectId = "project";
const bytes = Buffer.from("fixture MP3 byte stream ".repeat(10));
const hash = createHash("sha256").update(bytes).digest("hex");
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

function fixture(options: { tamper?: boolean; secondCheckFails?: boolean;
  musicState?: string; visualVersion?: number } = {}) {
  const project = { id: projectId, client_id: clientId,
    stage: "timed", ir_version: options.visualVersion ?? 2,
    audio_ir_version: 2, ir, music_path: null };
  const scenes = ir.scenes.map((source: { id: string; narration: string },
    index: number) => {
    const path = `${clientId}/video/projects/${projectId}`
      + `/ir-v2/scenes/${source.id}/audio.mp3`;
    const alignment = source.narration.split(" ").map((text: string,
      word: number) => ({ text, startSec: word * 0.3,
      endSec: word * 0.3 + 0.2, loss: 0.01 }));
    return { id: `scene-${index}`, client_id: clientId,
      project_id: projectId, position: index + 1,
      scene_key: source.id, narration: source.narration,
      audio_path: path, duration_sec: 4, alignment };
  });
  const receipts = scenes.map((scene: typeof scenes[number]) => ({
    scene_id: scene.id, client_id: clientId, project_id: projectId,
    ir_version: 2, narration_sha256: digest(scene.narration),
    audio_sha256: hash, storage_path: scene.audio_path,
    file_bytes: bytes.length, duration_sec: 4,
    alignment: scene.alignment, alignment_loss: 0.01,
  }));
  const queries: Record<string, number> = {};
  const from = vi.fn((table: string) => {
    queries[table] = (queries[table] ?? 0) + 1;
    const rows = table === "video_projects" ? project
      : table === "video_scenes" ? scenes
      : table === "video_scene_audio_receipts_v1" ? receipts
      : table === "video_project_music_attempts_v1"
      ? { client_id: clientId, project_id: projectId,
        ir_version: 2, state: options.musicState ?? "skipped",
        requested: false } : null;
    const query = { select: () => query, eq: () => query,
      order: async () => ({ data: rows, error: null }),
      maybeSingle: async () => ({ data: rows, error: null }),
      then: (ok: (value: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(ok) };
    return query;
  });
  let checks = 0;
  const rpc = vi.fn(async () => ({ data: ++checks === 2
    && options.secondCheckFails ? false : true, error: null }));
  const download = vi.fn(async () => ({ data: new Blob([
    Uint8Array.from(options.tamper ? Buffer.from("changed bytes") : bytes)]),
  error: null }));
  const createSignedUrl = vi.fn(async (path: string, lifetime: number) => ({
    data: { signedUrl: `https://media.example.test/${path}?ttl=${lifetime}` },
    error: null }));
  const storage = { from: () => ({ download, createSignedUrl }) };
  const sb = { from, rpc, storage } as unknown as SupabaseClient;
  return { sb, rpc, download, createSignedUrl, scenes, receipts };
}

describe("render input preflight", () => {
  it("reads exact IR, verifies media bytes and repeats the database identity check", async () => {
    const db = fixture();
    const result = await buildVideoRenderInputs({ sb: db.sb,
      clientId, projectId, maxAlignmentLoss: 0.25 });
    expect(result.irVersion).toBe(2);
    expect(result.timings.scenes.map((scene) => scene.id))
      .toEqual(["s01", "s02", "s03"]);
    expect(db.download).toHaveBeenCalledTimes(3);
    expect(db.createSignedUrl).toHaveBeenCalledTimes(3);
    expect(db.createSignedUrl).toHaveBeenCalledWith(db.scenes[0]?.audio_path, 7200);
    expect(db.rpc).toHaveBeenCalledTimes(2);
  });

  it("holds changed bytes and a failed final identity readback", async () => {
    const changed = fixture({ tamper: true });
    await expect(buildVideoRenderInputs({ sb: changed.sb, clientId,
      projectId, maxAlignmentLoss: 0.25 })).rejects.toThrow(/bytes differ/);
    expect(changed.createSignedUrl).not.toHaveBeenCalled();
    const replaced = fixture({ secondCheckFails: true });
    await expect(buildVideoRenderInputs({ sb: replaced.sb, clientId,
      projectId, maxAlignmentLoss: 0.25 })).rejects.toThrow(/no longer complete/);
    const unfinished = fixture({ musicState: "started" });
    await expect(buildVideoRenderInputs({ sb: unfinished.sb, clientId,
      projectId, maxAlignmentLoss: 0.25 })).rejects.toThrow(/not terminal/);
    expect(unfinished.download).not.toHaveBeenCalled();
  });

  it("binds a visual IR revision to unchanged verified audio bytes", async () => {
    const db = fixture({ visualVersion: 3 });
    const result = await buildVideoRenderInputs({ sb: db.sb,
      clientId, projectId, maxAlignmentLoss: 0.25 });
    expect(result.irVersion).toBe(3);
    expect(db.createSignedUrl).toHaveBeenCalledWith(
      `${clientId}/video/projects/${projectId}/ir-v2/scenes/s01/audio.mp3`,
      7200);
    expect(db.rpc).toHaveBeenCalledWith("complete_video_audio_project_v1",
      { p_project_id: projectId, p_ir_version: 3 });
  });
});
