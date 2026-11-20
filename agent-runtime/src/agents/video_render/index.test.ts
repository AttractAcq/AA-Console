import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { AgentJobRow } from "../../queue.js";
import { VideoRenderUncertainError } from "../../video/render/handoff.js";
import { VideoCreativeReviewHeldError } from "../../video/render/finalize.js";
import { LambdaRenderObservationError } from "../../video/render/lambda.js";
import { runVideoRenderJobWithPipeline } from "./index.js";

const clientId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const aspects = ["16:9", "9:16", "1:1"];
type Pipeline = NonNullable<Parameters<typeof runVideoRenderJobWithPipeline>[5]>;
type Finalizer = NonNullable<Parameters<typeof runVideoRenderJobWithPipeline>[7]>;

function fixture() {
  const project = { id: projectId, client_id: clientId,
    stage: "timed", ir_version: 1, aspects };
  const events: unknown[] = [];
  const from = vi.fn((table: string) => {
    const query = { select: () => query, eq: () => query,
      maybeSingle: async () => ({ data: table === "video_project_attachments_v1"
        ? { asset_id: "asset-1" } : project, error: null }),
      insert: async (value: unknown) => { events.push(value);
        return { error: null }; } };
    if (table !== "video_projects" && table !== "agent_job_events"
      && table !== "video_project_attachments_v1") {
      throw new Error(`Unexpected table ${table}`);
    }
    return query;
  });
  const sb = { from } as unknown as SupabaseClient;
  const config = { remotionAwsRegion: "eu-central-1",
    remotionFunctionName: "remotion-render-test",
    remotionServeUrl: "https://site.example.test",
    supabaseUrl: "https://example.supabase.co",
    supabaseServiceRoleKey: "test-secret" } as RuntimeConfig;
  const agent: AgentRow = { agent_key: "video_render", name: "Video render",
    initials: "VR", domain: "content_production", description: null,
    requires_upstream: [], paused: false,
    config: { max_alignment_loss: 0.25 } };
  const job: AgentJobRow = { id: jobId, agent_key: "video_render",
    client_id: clientId, input_table: "video_projects",
    input_id: projectId, params: { ir_version: 1, aspects },
    status: "running", attempts: 1, max_attempts: 3,
    lease_owner: "test", lease_until: null };
  const pipeline = vi.fn(async (input: { aspect: string }) => ({
    candidateId: `candidate-${input.aspect}`, probeResult: "pass" as const,
    resumed: false })) as unknown as Pipeline;
  const finalizer = vi.fn(async () => ({ state: "attached" as const,
    assetId: "asset-1" })) as unknown as Finalizer;
  return { sb, config, agent, job, project, pipeline, finalizer, events };
}

describe("video render worker", () => {
  it("renders every exact requested aspect and records separate candidates", async () => {
    const f = fixture();
    const result = await runVideoRenderJobWithPipeline(f.sb, f.config,
      f.agent, f.job, Date.now() + 4 * 60 * 60_000,
      f.pipeline, () => true, f.finalizer);
    expect(result).toEqual({ ok: true, retryable: false });
    expect(f.pipeline).toHaveBeenCalledTimes(3);
    expect(vi.mocked(f.pipeline).mock.calls.map(([input]) => input.aspect))
      .toEqual(aspects);
    expect(f.events).toHaveLength(4);
    expect(f.finalizer).toHaveBeenCalledWith(expect.objectContaining({
      projectId, candidateIds: new Map(aspects.map((aspect) =>
        [aspect, `candidate-${aspect}`])) }));
  });

  it("holds an unconfigured deployment or alignment policy", async () => {
    const f = fixture();
    f.config.remotionServeUrl = null;
    const result = await runVideoRenderJobWithPipeline(f.sb, f.config,
      f.agent, f.job, Date.now() + 4 * 60 * 60_000,
      f.pipeline, () => true, f.finalizer);
    expect(result.hold).toBe(true);
    expect(f.pipeline).not.toHaveBeenCalled();
  });

  it("rejects a job whose aspect list differs from the project", async () => {
    const f = fixture();
    f.job.params = { ir_version: 1, aspects: ["16:9"] };
    const result = await runVideoRenderJobWithPipeline(f.sb, f.config,
      f.agent, f.job, Date.now() + 4 * 60 * 60_000,
      f.pipeline, () => true, f.finalizer);
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(f.pipeline).not.toHaveBeenCalled();
  });

  it("does not restart an uncertain Lambda attempt", async () => {
    const f = fixture();
    vi.mocked(f.pipeline).mockRejectedValueOnce(
      new VideoRenderUncertainError("attempt-1", "start unknown"));
    const result = await runVideoRenderJobWithPipeline(f.sb, f.config,
      f.agent, f.job, Date.now() + 4 * 60 * 60_000,
      f.pipeline, () => true, f.finalizer);
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(f.events).toHaveLength(0);
  });

  it("stops for review on a failed physical probe", async () => {
    const f = fixture();
    vi.mocked(f.pipeline).mockResolvedValueOnce({ candidateId: "failed",
      probeResult: "fail", resumed: false });
    const result = await runVideoRenderJobWithPipeline(f.sb, f.config,
      f.agent, f.job, Date.now() + 4 * 60 * 60_000,
      f.pipeline, () => true, f.finalizer);
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(f.events).toHaveLength(1);
    expect(f.pipeline).toHaveBeenCalledTimes(1);
    expect(f.finalizer).not.toHaveBeenCalled();
  });

  it("holds a creative review with an unresolved paid attempt", async () => {
    const f = fixture();
    vi.mocked(f.finalizer).mockRejectedValueOnce(
      new VideoCreativeReviewHeldError("Creative attempt is already claimed."));
    const result = await runVideoRenderJobWithPipeline(f.sb, f.config,
      f.agent, f.job, Date.now() + 4 * 60 * 60_000,
      f.pipeline, () => true, f.finalizer);
    expect(result).toMatchObject({ ok: false, retryable: false, hold: true });
  });

  it("reconciles an already attached asset without another render", async () => {
    const f = fixture();
    f.project.stage = "attached";
    const result = await runVideoRenderJobWithPipeline(f.sb, f.config,
      f.agent, f.job, Date.now() + 4 * 60 * 60_000,
      f.pipeline, () => false, f.finalizer);
    expect(result).toEqual({ ok: true, retryable: false });
    expect(f.pipeline).not.toHaveBeenCalled();
    expect(f.finalizer).not.toHaveBeenCalled();
  });

  it("retries only an observational Lambda failure, never a fatal render", async () => {
    const f = fixture();
    const handle = { region: "eu-central-1" as const,
      functionName: "remotion-render-test", renderId: "render1",
      bucketName: "bucket", outName: "video.mp4",
      serveUrl: "https://site.example.test" };
    vi.mocked(f.pipeline).mockRejectedValueOnce(
      new LambdaRenderObservationError("Lambda render observation timed out", handle));
    const retry = await runVideoRenderJobWithPipeline(f.sb, f.config,
      f.agent, f.job, Date.now() + 4 * 60 * 60_000,
      f.pipeline, () => true, f.finalizer);
    expect(retry).toMatchObject({ ok: false, retryable: true });
    vi.mocked(f.pipeline).mockRejectedValueOnce(
      new LambdaRenderObservationError("Lambda render failed; provider fatal", handle));
    const fatal = await runVideoRenderJobWithPipeline(f.sb, f.config,
      f.agent, f.job, Date.now() + 4 * 60 * 60_000,
      f.pipeline, () => true, f.finalizer);
    expect(fatal).toMatchObject({ ok: false, retryable: false });
  });
});
