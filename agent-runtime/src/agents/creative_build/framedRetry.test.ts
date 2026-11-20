import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { AgentJobRow } from "../../queue.js";
import { MOTION_PRESET_PLACEHOLDER, serializeShot } from "../brief/shots.js";

vi.mock("../../creative/attest-asset-route.js", () => ({
  attestCreativeAssetBytes: vi.fn().mockResolvedValue(undefined),
}));

import { attestCreativeAssetBytes } from "../../creative/attest-asset-route.js";
import { runCreativeBuildJob } from "./index.js";

const clientId = "00000000-0000-0000-0000-000000000001";
const renderId = "00000000-0000-0000-0000-000000000002";
const assetId = "00000000-0000-0000-0000-000000000003";
const briefId = "00000000-0000-0000-0000-000000000004";
const generationId = "00000000-0000-0000-0000-000000000005";

it("recovers a filed reel frame set without another model call or asset insert", async () => {
  const writes: Array<{ table: string; kind: string; value: unknown }> = [];
  const rpc = vi.fn();
  const from = (table: string) => {
    const query = {
      select: () => query,
      eq: () => query,
      like: () => query,
      update: (value: unknown) => { writes.push({ table, kind: "update", value }); return query; },
      insert: async (value: unknown) => { writes.push({ table, kind: "insert", value }); return { error: null }; },
      limit: async () => ({ data: table === "client_media_assets" ? [{
        id: assetId, brief_id: briefId, media_type: "video", content_format: "reel",
        review_status: "pending", human_approved_at: null, archived_at: null,
      }] : [], error: null }),
      maybeSingle: async () => ({ data: table === "creative_renders" ? {
        id: renderId, generation_id: generationId, quality: "medium", size: "1024x1536",
        reference_path: null,
      } : table === "creative_generations" ? {
        id: generationId, brief_id: briefId, media_type: "image", concept: { frames: [] },
        stage: "render", reference_path: null, remake_feedback: null,
      } : table === "client_briefs" ? {
        id: briefId, client_id: clientId, title: "Reel", body: "Show the mechanism",
        visual_direction: "Clean", media_type: "video", brief_ref: null,
        purpose: "client", recruitment_role: null, content_format: "reel", format_code: "F6",
        frame_count: 2, frame_plan: ["Show the situation", "Show the result"].map((beat) =>
          serializeShot({ beat, duration_sec: 3, shot_source_kind: "ai_generated",
            motion_preset: MOTION_PRESET_PLACEHOLDER })),
      } : null, error: null }),
      then: (resolve: (value: { error: null }) => unknown) => Promise.resolve({ error: null }).then(resolve),
    };
    return query;
  };
  const sb = { from, rpc } as unknown as SupabaseClient;
  const job = {
    id: "job-1", agent_key: "creative_build", client_id: clientId,
    input_table: "creative_renders", input_id: renderId,
    params: { render_id: renderId, opening_stills: true },
    status: "running", attempts: 2, max_attempts: 3, lease_owner: "worker", lease_until: null,
  } as AgentJobRow;
  const result = await runCreativeBuildJob(sb, {
    openaiApiKey: "fixture-key", conceptProvider: "anthropic",
  } as RuntimeConfig, { agent_key: "creative_build", name: "Creative Build" } as AgentRow,
  job, Date.now() + 10_000);
  expect(result).toMatchObject({ ok: true, retryable: false });
  expect(attestCreativeAssetBytes).toHaveBeenCalledWith(sb, clientId, assetId);
  expect(rpc).not.toHaveBeenCalled();
  expect(writes).not.toContainEqual(expect.objectContaining({ table: "client_media_assets", kind: "insert" }));
  expect(writes).toContainEqual(expect.objectContaining({ table: "creative_renders", kind: "update",
    value: expect.objectContaining({ status: "done", asset_id: assetId }) }));
});
