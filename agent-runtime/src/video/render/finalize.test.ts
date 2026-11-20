import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../../config.js";
import { downloadCandidateExact, finalizeVideoProjectRender,
  VideoCreativeReviewHeldError } from "./finalize.js";
import type { CodeVideoCreativeReview } from "./creative.js";

const clientId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const firstId = "44444444-4444-4444-8444-444444444444";
const secondId = "55555555-5555-4555-8555-555555555555";
const attemptId = "66666666-6666-4666-8666-666666666666";
type Deps = NonNullable<Parameters<typeof finalizeVideoProjectRender>[1]>;

function fixture() {
  const candidate = { id: firstId, client_id: clientId,
    project_id: projectId, ir_version: 1, aspect: "16:9" as const,
    storage_path: `${clientId}/video/candidate.mp4`,
    file_sha256: "a".repeat(64), file_bytes: 1024,
    probe_result: "pass", verdict: "pending",
    media_probe: { duration_sec: 6 } };
  const brand = { colour_primary: "#111111", never_do: "No stock imagery" };
  const from = vi.fn((table: string) => {
    const query = { select: () => query, eq: () => query,
      maybeSingle: async () => ({ data: table === "client_brand_profiles"
        ? brand : candidate, error: null }) };
    return query;
  });
  let claimState = "claimed";
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "claim_video_project_creative_v1") {
      return { data: { state: claimState, attempt_id: attemptId }, error: null };
    }
    if (name === "finish_video_project_creative_v1") {
      return { data: firstId, error: null };
    }
    if (name === "mark_video_project_creative_uncertain_v1") {
      return { data: true, error: null };
    }
    if (name === "decide_video_project_render_candidate_v1") {
      return { data: args.p_candidate_id, error: null };
    }
    if (name === "attach_video_project_render_v1") {
      return { data: "asset-1", error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  const sb = { from, rpc } as unknown as SupabaseClient;
  const prepare = vi.fn(async () => ({ irVersion: 1,
    ir: { aspects: ["16:9", "9:16"],
      scenes: [{ narration: "First." }, { narration: "Second." }] },
    timings: { scenes: [{ id: "s01", durationSec: 3 },
      { id: "s02", durationSec: 3 }] } }));
  const review = vi.fn(async (): Promise<CodeVideoCreativeReview> => ({ result: "pass",
    summary: "All areas passed.", model: "model-test",
    checks: [], segments: [], sampled_frames: 6,
    usage: { inputTokens: 100, outputTokens: 20,
      cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02 } }));
  const download = vi.fn(async () => {});
  const deps = { prepare, review, download } as unknown as Deps;
  const config = { model: "model-test", anthropicApiKey: "test",
    anthropicApiKeyByAgent: {} } as RuntimeConfig;
  const input = { sb, config, clientId, projectId, jobId,
    irVersion: 1, aspects: ["16:9", "9:16"] as Array<"16:9" | "9:16">,
    candidateIds: new Map([["16:9", firstId], ["9:16", secondId]]) as
      ReadonlyMap<"16:9" | "9:16", string>,
    workDir: "/tmp/aa-video-finalize-test", maxAlignmentLoss: 0.25 };
  return { input, deps, rpc, candidate, prepare, review, download,
    setClaim: (state: string) => { claimState = state; } };
}

describe("code-video finalization", () => {
  it("files the paid first review before accepting derivatives and attaching", async () => {
    const f = fixture();
    expect(await finalizeVideoProjectRender(f.input, f.deps))
      .toEqual({ state: "attached", assetId: "asset-1" });
    expect(f.download).toHaveBeenCalledOnce();
    expect(f.review).toHaveBeenCalledWith(expect.objectContaining({
      narration: "First.\nSecond.", brandRules: expect.stringContaining("No stock imagery") }));
    expect(f.rpc.mock.calls.map(([name]) => name)).toEqual([
      "claim_video_project_creative_v1", "finish_video_project_creative_v1",
      "decide_video_project_render_candidate_v1",
      "attach_video_project_render_v1" ]);
  });

  it("does not spend again when a creative claim is already held", async () => {
    const f = fixture();
    f.setClaim("already_claimed");
    await expect(finalizeVideoProjectRender(f.input, f.deps))
      .rejects.toBeInstanceOf(VideoCreativeReviewHeldError);
    expect(f.review).not.toHaveBeenCalled();
    expect(f.rpc).not.toHaveBeenCalledWith("finish_video_project_creative_v1",
      expect.anything());
  });

  it("does not accept derivatives or attach after a failed creative review", async () => {
    const f = fixture();
    vi.mocked(f.review).mockResolvedValueOnce({ result: "fail",
      summary: "Contrast failed.", model: "model-test", checks: [],
      segments: [], sampled_frames: 6,
      usage: { inputTokens: 100, outputTokens: 20,
        cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02 } });
    expect(await finalizeVideoProjectRender(f.input, f.deps))
      .toEqual({ state: "rejected" });
    expect(f.rpc.mock.calls.map(([name]) => name)).toEqual([
      "claim_video_project_creative_v1", "finish_video_project_creative_v1" ]);
  });

  it("holds after an uncertain model result instead of repeating it", async () => {
    const f = fixture();
    vi.mocked(f.review).mockRejectedValueOnce(new Error("provider response lost"));
    await expect(finalizeVideoProjectRender(f.input, f.deps))
      .rejects.toBeInstanceOf(VideoCreativeReviewHeldError);
    expect(f.rpc.mock.calls.map(([name]) => name)).toEqual([
      "claim_video_project_creative_v1", "mark_video_project_creative_uncertain_v1" ]);
  });

  it("streams and hashes the exact private MP4 before review", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aa-finalize-bytes-"));
    const originalFetch = globalThis.fetch;
    try {
      const bytes = Buffer.alloc(256, 7);
      globalThis.fetch = vi.fn(async () => new Response(bytes));
      const sb = {
        storage: { from: () => ({
          createSignedUrl: async () => ({
            data: { signedUrl: "https://example.test/private" }, error: null,
          }),
        }) },
      } as unknown as SupabaseClient;
      const candidate = { ...fixture().candidate, file_bytes: bytes.length,
        file_sha256: createHash("sha256").update(bytes).digest("hex") };
      const path = join(directory, "candidate.mp4");
      await downloadCandidateExact({ sb, candidate, localPath: path });
      expect(await readFile(path)).toEqual(bytes);
      await expect(downloadCandidateExact({ sb,
        candidate: { ...candidate, file_sha256: "b".repeat(64) },
        localPath: join(directory, "wrong.mp4") }))
        .rejects.toThrow(/differs/);
    } finally { globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true }); }
  });
});
