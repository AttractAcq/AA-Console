import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { renderAndFileProjectAspect } from "./pipeline.js";

const clientId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";
const candidateId = "55555555-5555-4555-8555-555555555555";
const probe = { result: "pass" as const, width: 1920, height: 1080,
  duration_sec: 60, has_audio: true, audio_integrated_lufs: -14,
  audio_true_peak_dbfs: -1.6, black_intervals: [], freeze_intervals: [],
  checks: [] };
type Deps = NonNullable<Parameters<typeof renderAndFileProjectAspect>[1]>;

function fixture(priorCandidate = false) {
  const receipt = { id: candidateId, attempt_id: attemptId,
    client_id: clientId, project_id: projectId, ir_version: 1,
    aspect: "16:9", storage_path: "exact.mp4",
    file_sha256: "a".repeat(64), file_bytes: 1024,
    probe_result: "pass" };
  const attempt = { id: attemptId, job_id: jobId, state: "succeeded" };
  const from = vi.fn((table: string) => {
    const query = { select: () => query, eq: () => query,
      maybeSingle: async () => ({ data: table === "video_project_render_candidates_v1"
        ? (priorCandidate ? receipt : null) : attempt, error: null }) };
    return query;
  });
  const render = vi.fn(async () => ({ attemptId, handle: {},
    outputPath: "/tmp/master.mp4", sizeInBytes: 1024, probe }));
  const file = vi.fn(async () => candidateId);
  const verifyRemote = vi.fn(async () => {});
  const rpc = vi.fn(async () => ({ data: true, error: null }));
  const input = { sb: { from, rpc } as unknown as SupabaseClient,
    config: { supabaseUrl: "https://example.supabase.co",
      supabaseServiceRoleKey: "test-secret" },
    clientId, projectId, jobId, irVersion: 1, aspect: "16:9" as const,
    region: "eu-central-1" as const,
    functionName: "remotion", serveUrl: "https://site.example.test",
    localPath: "/tmp/raw.mp4", maxAlignmentLoss: 0.25 };
  const deps = { render, file, verifyRemote } as unknown as Deps;
  return { input, deps, from, rpc, render, file, verifyRemote, receipt, attempt };
}

describe("render candidate pipeline", () => {
  it("renders then files one exact candidate without attachment", async () => {
    const f = fixture();
    expect(await renderAndFileProjectAspect(f.input, f.deps)).toEqual({
      candidateId, probeResult: "pass", resumed: false });
    expect(f.render).toHaveBeenCalledOnce();
    expect(f.file).toHaveBeenCalledWith(expect.objectContaining({
      attemptId, outputPath: "/tmp/master.mp4", probe }));
  });

  it("reconciles a filed receipt without another Lambda start", async () => {
    const f = fixture(true);
    expect(await renderAndFileProjectAspect(f.input, f.deps)).toEqual({
      candidateId, probeResult: "pass", resumed: true });
    expect(f.render).not.toHaveBeenCalled();
    expect(f.file).not.toHaveBeenCalled();
    expect(f.rpc).toHaveBeenCalledWith("complete_video_audio_project_v1",
      { p_project_id: projectId, p_ir_version: 1 });
    expect(f.verifyRemote).toHaveBeenCalledWith(expect.objectContaining({
      storagePath: "exact.mp4", sha256: "a".repeat(64), size: 1024 }));
  });

  it("holds a prior candidate bound to another job", async () => {
    const f = fixture(true);
    f.attempt.job_id = "99999999-9999-4999-8999-999999999999";
    await expect(renderAndFileProjectAspect(f.input, f.deps))
      .rejects.toThrow("not bound to this render job");
    expect(f.render).not.toHaveBeenCalled();
  });

  it("holds a prior candidate after its source has changed", async () => {
    const f = fixture(true);
    f.rpc.mockResolvedValueOnce({ data: false, error: null });
    await expect(renderAndFileProjectAspect(f.input, f.deps))
      .rejects.toThrow("source is no longer current");
    expect(f.render).not.toHaveBeenCalled();
    expect(f.verifyRemote).not.toHaveBeenCalled();
  });
});
