import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { fileProjectRenderCandidate, verifyRemoteBytes } from "./candidate.js";

const clientId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";
const objectId = "55555555-5555-4555-8555-555555555555";
const candidateId = "66666666-6666-4666-8666-666666666666";
type Deps = NonNullable<Parameters<typeof fileProjectRenderCandidate>[1]>;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "aa-render-candidate-"));
  const outputPath = join(directory, "master.mp4");
  const bytes = Buffer.alloc(1024, 17);
  await writeFile(outputPath, bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const path = `${clientId}/video/projects/${projectId}/ir-v1/candidates/`
    + `${attemptId}-16x9-${sha}.mp4`;
  const identity = { client_id: clientId, project_id: projectId,
    attempt_id: attemptId, ir_version: 1, aspect: "16:9", storage_path: path,
    object_id: objectId, object_version: "v1",
    object_updated_at: "2026-11-20T12:00:00Z" };
  const rpc = vi.fn(async (name: string) => ({ data:
    name === "record_video_project_render_candidate_v1" ? candidateId : identity,
    error: null }));
  const prior = { data: null as Record<string, unknown> | null, error: null };
  const from = vi.fn(() => {
    const query = { select: () => query, eq: () => query,
      maybeSingle: async () => prior };
    return query;
  });
  const upload = vi.fn(async () => {});
  const verifyRemote = vi.fn(async () => {});
  const deps = { upload, verifyRemote } as unknown as Deps;
  const input = { sb: { rpc, from } as unknown as SupabaseClient,
    config: { supabaseUrl: "https://example.supabase.co",
      supabaseServiceRoleKey: "test-secret-do-not-log" },
    clientId, projectId, jobId, attemptId, irVersion: 1,
    aspect: "16:9" as const, outputPath,
    probe: { result: "pass" as const, width: 1920, height: 1080,
      duration_sec: 60, has_audio: true, audio_integrated_lufs: -14,
      audio_true_peak_dbfs: -1.6, black_intervals: [],
      freeze_intervals: [], checks: [] } };
  return { directory, input, deps, rpc, from, prior, upload, verifyRemote,
    identity, path, sha };
}

describe("exact project render candidate filing", () => {
  it("checks every downloaded byte rather than trusting a signed URL", async () => {
    const bytes = Buffer.alloc(1024, 17);
    const signedUrl = `data:application/octet-stream;base64,${bytes.toString("base64")}`;
    const sb = { storage: { from: () => ({ createSignedUrl: async () => ({
      data: { signedUrl }, error: null }) }) } } as unknown as SupabaseClient;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await expect(verifyRemoteBytes({ sb, storagePath: "candidate.mp4",
      sha256, size: 1024 })).resolves.toBeUndefined();
    await expect(verifyRemoteBytes({ sb, storagePath: "candidate.mp4",
      sha256: "0".repeat(64), size: 1024 }))
      .rejects.toThrow("differ from the mastered MP4");
  });

  it("binds stable Storage identity and verified remote bytes to the attempt", async () => {
    const f = await fixture();
    try {
      expect(await fileProjectRenderCandidate(f.input, f.deps)).toBe(candidateId);
      expect(f.upload).toHaveBeenCalledWith(expect.objectContaining({
        storagePath: f.path, sha256: f.sha }));
      expect(f.verifyRemote).toHaveBeenCalledWith(expect.objectContaining({
        storagePath: f.path, sha256: f.sha, size: 1024 }));
      expect(f.rpc).toHaveBeenLastCalledWith("record_video_project_render_candidate_v1",
        expect.objectContaining({ p_attempt_id: attemptId,
          p_storage_path: f.path, p_file_sha256: f.sha,
          p_object_id: objectId, p_media_probe: f.input.probe }));
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  });

  it("reconciles an uncertain upload only after exact read-back", async () => {
    const f = await fixture();
    try {
      f.upload.mockRejectedValueOnce(new Error("upload status unknown"));
      expect(await fileProjectRenderCandidate(f.input, f.deps)).toBe(candidateId);
      expect(f.verifyRemote).toHaveBeenCalledOnce();
      f.verifyRemote.mockRejectedValueOnce(new Error("wrong bytes"));
      await expect(fileProjectRenderCandidate(f.input, f.deps))
        .rejects.toThrow("wrong bytes");
      expect(f.rpc.mock.calls.filter((call) => call[0] ===
        "record_video_project_render_candidate_v1")).toHaveLength(1);
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  });

  it("holds an object replacement between identity reads", async () => {
    const f = await fixture();
    try {
      f.rpc.mockImplementation(async (name: string) => {
        if (name === "record_video_project_render_candidate_v1") {
          return { data: candidateId, error: null };
        }
        return { data: f.rpc.mock.calls.length > 1
          ? { ...f.identity, object_version: "v2" } : f.identity, error: null };
      });
      await expect(fileProjectRenderCandidate(f.input, f.deps))
        .rejects.toThrow("changed during byte verification");
      expect(f.rpc.mock.calls.some((call) => call[0] ===
        "record_video_project_render_candidate_v1")).toBe(false);
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  });

  it("resumes a filed candidate without another upload or RPC write", async () => {
    const f = await fixture();
    try {
      f.prior.data = { id: candidateId, project_id: projectId,
        client_id: clientId, ir_version: 1, aspect: "16:9",
        storage_path: f.path, file_sha256: f.sha, file_bytes: 1024,
        media_probe: f.input.probe };
      expect(await fileProjectRenderCandidate(f.input, f.deps)).toBe(candidateId);
      expect(f.upload).not.toHaveBeenCalled();
      expect(f.verifyRemote).toHaveBeenCalledOnce();
      expect(f.rpc).not.toHaveBeenCalled();
      f.prior.data = { ...f.prior.data, file_sha256: "0".repeat(64) };
      await expect(fileProjectRenderCandidate(f.input, f.deps))
        .rejects.toThrow("differs from this export");
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  });
});
