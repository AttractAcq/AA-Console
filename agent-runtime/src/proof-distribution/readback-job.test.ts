import { expect, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentJobRow } from "../queue.js";
import { runProofPlacementReadbackJob } from "./readback-job.js";

const id = "accounts/123/locations/456/localPosts/7";
const job = { id: "job-1", client_id: "client-1", input_table: "proof_placements",
  input_id: "placement-1" } as AgentJobRow;
const target = { placement_id: "placement-1", client_id: "client-1",
  external_id: id, account_ref: "accounts/123/locations/456",
  payload_hash: "a".repeat(64), media_required: false,
  artifact_version_id: "artifact-1", proof_id: null, asset_id: null };

function database(changes: { target?: unknown; integration?: unknown; recordError?: string } = {}) {
  const calls: string[] = [];
  const rpc = vi.fn(async (name: string) => {
    calls.push(name);
    if (name === "proof_placement_readback_target_v8") return {
      data: "target" in changes ? changes.target : target, error: null };
    if (name === "integration_secret") return { data: "token", error: null };
    if (name === "record_proof_placement_provider_read_v8") return {
      data: null, error: changes.recordError ? { message: changes.recordError } : null };
    return { data: null, error: null };
  });
  const from = vi.fn((table: string) => {
    if (table === "agent_job_events") return { insert: vi.fn(async () => ({ error: null })) };
    const chain: Record<string, unknown> = {};
    Object.assign(chain, { select: () => chain, eq: () => chain, maybeSingle: async () => ({
      data: table === "client_integrations"
        ? "integration" in changes ? changes.integration
          : { status: "active", credential_secret_id: "secret", token_expires_at: null }
        : { content: "Approved result" }, error: null,
    }) });
    return chain;
  });
  return { sb: { rpc, from } as unknown as SupabaseClient, rpc, calls };
}

test("readback records a matching LIVE post without calling a write transport", async () => {
  const { sb, rpc } = database();
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
    name: id, summary: "Approved result", state: "LIVE",
  })));
  vi.stubGlobal("fetch", fetchImpl);
  expect(await runProofPlacementReadbackJob(sb, {}, {}, job)).toMatchObject({ ok: true });
  expect(fetchImpl).toHaveBeenCalledWith(
    `https://mybusiness.googleapis.com/v4/${id}`, expect.objectContaining({ method: "GET" }));
  expect(rpc).toHaveBeenCalledWith("record_proof_placement_provider_read_v8",
    expect.objectContaining({ p_result: "live_exact_text", p_external_id: id }));
  expect(rpc.mock.calls.some(([name]) => name === "record_proof_placed")).toBe(false);
});

test("a stale target or credential cannot call the provider", async () => {
  const fetchImpl = vi.fn();
  vi.stubGlobal("fetch", fetchImpl);
  expect((await runProofPlacementReadbackJob(database({ target: null }).sb, {}, {}, job)).ok).toBe(false);
  expect((await runProofPlacementReadbackJob(database({ integration: null }).sb, {}, {}, job)).ok).toBe(false);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("failed observation storage is not reported as a completed readback", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    name: id, summary: "Approved result", state: "LIVE",
  }))));
  const result = await runProofPlacementReadbackJob(database({ recordError: "stale" }).sb, {}, {}, job);
  expect(result).toMatchObject({ ok: false, retryable: false });
});
