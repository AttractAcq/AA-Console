import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
import { attestCampaignCreativeWorkflowOutputs } from "./attest-campaign-workflow.js";

const CLIENT = "00000000-0000-0000-0000-000000000001";
const RUN = "00000000-0000-0000-0000-000000000002";
const STEP = "00000000-0000-0000-0000-000000000003";
const JOB = "00000000-0000-0000-0000-000000000004";
const BRIEF = "00000000-0000-0000-0000-000000000005";
const ASSET = "00000000-0000-0000-0000-000000000006";
const OBJECT = "00000000-0000-0000-0000-000000000007";

function database(jobStatus = "completed", digest: string | null = null) {
  const file = Buffer.from("the exact produced creative file");
  const identity = { asset_id: ASSET, client_id: CLIENT, object_id: OBJECT,
    storage_path: `${CLIENT}/${ASSET}/creative.png`, object_version: "v1",
    object_updated_at: "2026-11-16T00:00:00Z" };
  const data: Record<string, unknown[]> = {
    workflow_runs: [{ id: RUN, client_id: CLIENT }],
    workflow_steps: [{ id: STEP, run_id: RUN, agent_key: "creative_build",
      resolved_input_id: BRIEF, job_id: JOB }],
    agent_jobs: [{ id: JOB, status: jobStatus, created_at: "2026-11-16T00:00:00Z" }],
    client_media_assets: [{ id: ASSET, delivery_bytes_sha256: digest }],
  };
  const from = vi.fn((table: string) => {
    const query = {
      select: () => query, eq: () => query, in: () => query,
      gte: () => query, limit: () => query,
      then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: data[table] ?? [], error: null }).then(resolve),
    };
    return query;
  });
  const rpc = vi.fn(async (name: string) => ({
    data: name === "creative_storage_identity_v6" ? identity
      : name === "creative_frame_storage_identities_v8" ? null : ASSET,
    error: null,
  }));
  const sb = { from, rpc, storage: { from: () => ({
    download: async () => ({ data: new Blob([file]), error: null }),
  }) } } as unknown as SupabaseClient;
  return { sb, rpc, file, identity };
}

it("attests a completed campaign creative before its workflow QA", async () => {
  const { sb, rpc, file, identity } = database();
  expect(await attestCampaignCreativeWorkflowOutputs(sb)).toBe(1);
  expect(rpc).toHaveBeenCalledWith("attest_creative_storage_bytes_v6", {
    p_asset_id: ASSET, p_storage_path: identity.storage_path,
    p_sha256: createHash("sha256").update(file).digest("hex"),
    p_file_bytes: file.length, p_object_id: OBJECT,
    p_object_version: "v1", p_object_updated_at: identity.object_updated_at,
  });
});

it("does not attest unfinished jobs or already attested assets", async () => {
  const unfinished = database("running");
  expect(await attestCampaignCreativeWorkflowOutputs(unfinished.sb)).toBe(0);
  expect(unfinished.rpc).not.toHaveBeenCalled();
  const verified = database("completed", "a".repeat(64));
  expect(await attestCampaignCreativeWorkflowOutputs(verified.sb)).toBe(0);
  expect(verified.rpc).not.toHaveBeenCalled();
});
