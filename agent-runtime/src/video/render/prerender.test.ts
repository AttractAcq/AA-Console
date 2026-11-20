import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../../config.js";
import { runPreRenderCritic, PreRenderReviewHeldError } from "./prerender.js";

const ir = JSON.parse(readFileSync(resolve(import.meta.dirname,
  "../../../../video-render/fixtures/ir/three-scene-v2.json"), "utf8"));
const clientId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";
type Dependencies = NonNullable<Parameters<typeof runPreRenderCritic>[1]>;

function fixture(claimState = "claimed") {
  const calls: string[] = [];
  const rpc = vi.fn(async (name: string) => {
    calls.push(name);
    if (name === "claim_video_project_prerender_v1") {
      return { data: { state: claimState, attempt_id: attemptId }, error: null };
    }
    if (name === "finish_video_project_prerender_v1") {
      return { data: "pass", error: null };
    }
    return { data: true, error: null };
  });
  const from = vi.fn(() => {
    const query = { select: () => query, eq: () => query,
      maybeSingle: async () => ({ data: { colour_primary: "navy" },
        error: null }) };
    return query;
  });
  const sb = { rpc, from } as unknown as SupabaseClient;
  const prepare = vi.fn(async () => ({ ir, irVersion: 1,
    timings: { scenes: ir.scenes.map((scene: { id: string }) => ({
      id: scene.id, audioSrc: "https://example.test/audio.mp3",
      durationSec: 2, words: [] })) } }));
  const frames = ir.scenes.flatMap((scene: { id: string }, index: number) =>
    [6, 30, 54].map((frame) => ({ sceneId: scene.id,
      frame: index * 60 + frame, jpeg: Buffer.alloc(120),
      costUsd: 0.001, renderId: `still-${index}-${frame}` })));
  const stills = vi.fn(async () => frames);
  const review = vi.fn(async () => ({ result: "pass" as const,
    checks: [], patch: [], model: "claude-sonnet-4-5",
    sampled_frames: 9, batches: 1,
    usage: { inputTokens: 100, outputTokens: 20,
      cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.012 } }));
  const deps = { prepare, stills, review } as unknown as Dependencies;
  const config = { model: "claude-sonnet-4-5",
    anthropicApiKey: "test-key", anthropicApiKeyByAgent: {} } as RuntimeConfig;
  const input = { sb, config, clientId, projectId, jobId,
    irVersion: 1, aspect: "16:9" as const,
    region: "eu-central-1" as const,
    functionName: "render-test", serveUrl: "https://site.example.test",
    maxAlignmentLoss: 0.25 };
  return { input, deps, calls, rpc, prepare, stills, review };
}

describe("exact pre-render paid critic handoff", () => {
  it("claims before paid stills and files report and both costs together", async () => {
    const f = fixture();
    expect(await runPreRenderCritic(f.input, f.deps)).toBe("pass");
    expect(f.calls).toEqual(["claim_video_project_prerender_v1",
      "finish_video_project_prerender_v1"]);
    expect(f.stills).toHaveBeenCalledWith(expect.objectContaining({
      projectId, irVersion: 1, attemptId }));
    expect(f.rpc).toHaveBeenCalledWith("finish_video_project_prerender_v1",
      expect.objectContaining({ p_still_usd: 0.009,
        p_model_usd: 0.012, p_input_tokens: 100,
        p_still_receipts: expect.arrayContaining([
          expect.objectContaining({ sceneId: "s01", renderId: "still-0-6" })]) }));
  });

  it("reuses a decided pass without repeating paid work", async () => {
    const f = fixture("decided_pass");
    expect(await runPreRenderCritic(f.input, f.deps)).toBe("pass");
    expect(f.stills).not.toHaveBeenCalled();
    expect(f.review).not.toHaveBeenCalled();
  });

  it("holds a claimed replay and an uncertain model response", async () => {
    const replay = fixture("already_claimed");
    await expect(runPreRenderCritic(replay.input, replay.deps))
      .rejects.toBeInstanceOf(PreRenderReviewHeldError);
    expect(replay.stills).not.toHaveBeenCalled();
    const uncertain = fixture();
    uncertain.review.mockRejectedValueOnce(new Error("provider timeout"));
    await expect(runPreRenderCritic(uncertain.input, uncertain.deps))
      .rejects.toBeInstanceOf(PreRenderReviewHeldError);
    expect(uncertain.calls).toEqual(["claim_video_project_prerender_v1",
      "mark_video_project_prerender_uncertain_v1"]);
  });
});
