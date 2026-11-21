import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../../config.js";
import { renderAndFileProjectThumbnail, ThumbnailOutcomeHeldError }
  from "./thumbnail.js";

const clientId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const firstCandidateId = "44444444-4444-4444-8444-444444444444";
const attemptId = "55555555-5555-4555-8555-555555555555";
const objectId = "66666666-6666-4666-8666-666666666666";
const updated = "2026-11-21T00:00:00.000Z";
const inputBase = { clientId, projectId, jobId, irVersion: 1,
  firstCandidateId, region: "eu-central-1" as const,
  functionName: "remotion-render-test",
  serveUrl: "https://site.example.test", maxAlignmentLoss: 0.25 };
const config = { supabaseUrl: "https://example.supabase.co",
  supabaseServiceRoleKey: "test-key" } as RuntimeConfig;

async function fixture(options: { width?: number;
  failCost?: boolean; replaceObject?: boolean } = {}) {
  const jpeg = await sharp({ create: { width: options.width ?? 1280,
    height: 720, channels: 3, background: "#123456" } }).jpeg().toBuffer();
  const sha256 = createHash("sha256").update(jpeg).digest("hex");
  const storagePath = `${clientId}/video/projects/${projectId}`
    + `/ir-v1/thumbnail-${attemptId}-${sha256}.jpg`;
  let state = "none";
  let identityReads = 0;
  const upload = vi.fn(async () => ({ data: { path: storagePath }, error: null }));
  const rpc = vi.fn(async (name: string) => {
    if (name === "claim_video_project_thumbnail_v1") {
      const answer = state === "none" ? "claimed" : `already_${state}`;
      if (state === "none") state = "claimed";
      return { data: { state: answer, attempt_id: attemptId }, error: null };
    }
    if (name === "record_video_project_thumbnail_provider_v1") {
      if (options.failCost) return { data: null,
        error: { message: "ledger unavailable" } };
      state = "rendered";
      return { data: "77777777-7777-4777-8777-777777777777", error: null };
    }
    if (name === "video_project_thumbnail_storage_identity_v1") {
      identityReads++;
      return { data: { client_id: clientId, project_id: projectId,
        attempt_id: attemptId, ir_version: 1, storage_path: storagePath,
        object_id: options.replaceObject && identityReads > 1
          ? "88888888-8888-4888-8888-888888888888" : objectId,
        object_version: "v1", object_updated_at: updated }, error: null };
    }
    if (name === "file_video_project_thumbnail_v1") {
      state = "filed";
      return { data: attemptId, error: null };
    }
    if (name === "mark_video_project_thumbnail_uncertain_v1") {
      state = "uncertain";
      return { data: true, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  const from = vi.fn((name: string) => {
    if (name !== "video_project_thumbnail_attempts_v1") {
      throw new Error(`Unexpected table ${name}`);
    }
    const query = { select: () => query, eq: () => query,
      maybeSingle: async () => ({ data: state === "filed" ? {
        id: attemptId, client_id: clientId, project_id: projectId,
        ir_version: 1, job_id: jobId, first_candidate_id: firstCandidateId,
        state, storage_path: storagePath, file_sha256: sha256,
        file_bytes: jpeg.length, object_id: objectId,
        object_version: "v1", object_updated_at: updated,
        provider_render_id: "render-1", provider_usd: 0.001,
      } : null, error: null }) };
    return query;
  });
  const sb = { rpc, from,
    storage: { from: () => ({ upload }) } } as unknown as SupabaseClient;
  const still = vi.fn(async () => ({ url: "https://lambda.example.test/thumb",
    sizeInBytes: jpeg.length, renderId: "render-1",
    estimatedPrice: { currency: "USD", accruedSoFar: 0.001 } }));
  const download = vi.fn(async () => new Response(jpeg));
  const verifyRemote = vi.fn(async () => {});
  const prepare = vi.fn(async () => ({ irVersion: 1,
    ir: { title: "Reviewed video title" }, brandSnapshot: {},
    timings: { scenes: [] } }));
  const deps = { still, download, verifyRemote, prepare } as unknown as
    NonNullable<Parameters<typeof renderAndFileProjectThumbnail>[1]>;
  return { sb, deps, rpc, upload, still, download, verifyRemote,
    storagePath, getState: () => state };
}

describe("exact project thumbnail filing", () => {
  it("costs one provider response, verifies JPEG and Storage, then reuses the receipt", async () => {
    const f = await fixture();
    const input = { ...inputBase, sb: f.sb, config };
    expect(await renderAndFileProjectThumbnail(input,f.deps)).toBe(attemptId);
    expect(f.getState()).toBe("filed");
    expect(f.upload).toHaveBeenCalledWith(f.storagePath,
      expect.any(Buffer),expect.objectContaining({ upsert: false,
        contentType: "image/jpeg" }));
    expect(f.verifyRemote).toHaveBeenCalledWith(expect.objectContaining({
      storagePath: f.storagePath }));
    expect(await renderAndFileProjectThumbnail(input,f.deps)).toBe(attemptId);
    expect(f.still).toHaveBeenCalledTimes(1);
    expect(f.rpc.mock.calls.filter(([name]) =>
      name === "record_video_project_thumbnail_provider_v1")).toHaveLength(1);
  });

  it("holds a malformed image after recording the provider cost", async () => {
    const f = await fixture({ width: 1000 });
    const input = { ...inputBase, sb: f.sb, config };
    await expect(renderAndFileProjectThumbnail(input,f.deps))
      .rejects.toBeInstanceOf(ThumbnailOutcomeHeldError);
    expect(f.getState()).toBe("uncertain");
    expect(f.upload).not.toHaveBeenCalled();
    await expect(renderAndFileProjectThumbnail(input,f.deps))
      .rejects.toThrow(/reconcile before another paid render/);
    expect(f.still).toHaveBeenCalledTimes(1);
  });

  it("holds a failed cost record or changing Storage object before filing", async () => {
    const cost = await fixture({ failCost: true });
    await expect(renderAndFileProjectThumbnail({ ...inputBase,
      sb: cost.sb, config },cost.deps)).rejects.toBeInstanceOf(
        ThumbnailOutcomeHeldError);
    expect(cost.upload).not.toHaveBeenCalled();
    const swapped = await fixture({ replaceObject: true });
    await expect(renderAndFileProjectThumbnail({ ...inputBase,
      sb: swapped.sb, config },swapped.deps)).rejects.toBeInstanceOf(
        ThumbnailOutcomeHeldError);
    expect(swapped.rpc.mock.calls.map(([name]) => name))
      .not.toContain("file_video_project_thumbnail_v1");
  });
});
