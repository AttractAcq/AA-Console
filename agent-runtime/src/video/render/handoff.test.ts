import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { LambdaRenderStartUnknownError } from "./lambda.js";
import { renderProjectAspect, VideoRenderUncertainError } from "./handoff.js";

const clientId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";
const handle = { region: "eu-central-1" as const,
  functionName: "remotion-render-test", renderId: "render123",
  bucketName: "remotion-bucket",
  outName: `${projectId}-16x9.mp4`,
  serveUrl: "https://site.example.test" };
const input = { clientId, projectId, jobId, irVersion: 1,
  aspect: "16:9" as const, region: handle.region,
  functionName: handle.functionName,
  serveUrl: "https://site.example.test", localPath: "/tmp/video.mp4",
  maxAlignmentLoss: 0.25 };
type Deps = NonNullable<Parameters<typeof renderProjectAspect>[1]>;

function fixture(state: string) {
  const calls: string[] = [];
  const attempt = { id: attemptId, project_id: projectId,
    client_id: clientId, ir_version: 1, aspect: "16:9",
    job_id: jobId, state: "started", region: handle.region,
    function_name: handle.functionName, render_id: handle.renderId,
    bucket_name: handle.bucketName, out_name: handle.outName,
    serve_url: handle.serveUrl };
  const rpc = vi.fn(async (name: string) => {
    calls.push(name);
    if (name === "claim_video_project_render_v1") {
      return { data: { state, attempt_id: attemptId }, error: null };
    }
    return { data: true, error: null };
  });
  const from = vi.fn(() => {
    const query = { select: () => query, eq: () => query,
      maybeSingle: async () => ({ data: attempt, error: null }) };
    return query;
  });
  const sb = { rpc, from } as unknown as SupabaseClient;
  const prepare = vi.fn(async () => ({ irVersion: 1,
    ir: { aspects: ["16:9"] }, timings: { scenes: [] },
    brandSnapshot: { colour_primary: "#123456" } }));
  const start = vi.fn(async (request: { onStarted: (value: typeof handle) => Promise<void> }) => {
    await request.onStarted(handle);
    return handle;
  });
  const resume = vi.fn(async () => ({ outputPath: input.localPath,
    sizeInBytes: 1000, progress: { done: true,
      estimatedBillingDurationInMilliseconds: 42000,
      costs: { accruedSoFar: 0.036, currency: "USD" } } }));
  const master = vi.fn(async () => ({ outputPath: "/tmp/video-master.mp4",
    fileBytes: 900 }));
  const probe = vi.fn(async () => ({ result: "pass", width: 1920,
    height: 1080, duration_sec: 60, has_audio: true,
    audio_integrated_lufs: -14, audio_true_peak_dbfs: -1.6,
    black_intervals: [], freeze_intervals: [], checks: [] }));
  const deps = { prepare, start, resume, master, probe } as unknown as Deps;
  return { sb, calls, rpc, from, prepare, start, resume, master, probe, deps };
}

describe("exact render handoff", () => {
  it("preflights, claims once, files the handle, then observes that handle", async () => {
    const f = fixture("claimed");
    const result = await renderProjectAspect({ sb: f.sb, ...input }, f.deps);
    expect(result).toMatchObject({ attemptId, handle,
      outputPath: "/tmp/video-master.mp4", sizeInBytes: 900,
      probe: { result: "pass" },
      providerEstimate: { billingMs: 42000, estimatedUsd: 0.036,
        currency: "USD" } });
    expect(f.calls).toEqual(["claim_video_project_render_v1",
      "record_video_project_lambda_handle_v2"]);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.resume).toHaveBeenCalledWith({ handle,
      localPath: input.localPath });
    expect(f.master).toHaveBeenCalledWith({ sourcePath: input.localPath,
      outputPath: "/tmp/video-master.mp4" });
    expect(f.probe).toHaveBeenCalledWith({ path: "/tmp/video-master.mp4",
      aspect: "16:9" });
  });

  it("resumes an exact stored handle without another provider start", async () => {
    const f = fixture("already_started");
    await renderProjectAspect({ sb: f.sb, ...input }, f.deps);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.from).toHaveBeenCalledWith("video_project_render_attempts_v1");
    expect(f.resume).toHaveBeenCalledTimes(1);
    await expect(renderProjectAspect({ sb: f.sb, ...input,
      serveUrl: "https://site.example.test/changed" }, f.deps))
      .rejects.toBeInstanceOf(VideoRenderUncertainError);
    expect(f.start).not.toHaveBeenCalled();
  });

  it("holds a claimed-without-handle or uncertain provider start", async () => {
    const stale = fixture("already_claimed");
    await expect(renderProjectAspect({ sb: stale.sb, ...input }, stale.deps))
      .rejects.toBeInstanceOf(VideoRenderUncertainError);
    expect(stale.calls).toEqual(["claim_video_project_render_v1",
      "mark_video_project_render_uncertain_v1"]);
    expect(stale.start).not.toHaveBeenCalled();
    const unknown = fixture("claimed");
    unknown.start.mockRejectedValueOnce(new LambdaRenderStartUnknownError());
    await expect(renderProjectAspect({ sb: unknown.sb, ...input }, unknown.deps))
      .rejects.toBeInstanceOf(VideoRenderUncertainError);
    expect(unknown.calls).toEqual(["claim_video_project_render_v1",
      "mark_video_project_render_uncertain_v1"]);
    expect(unknown.resume).not.toHaveBeenCalled();
  });
});
