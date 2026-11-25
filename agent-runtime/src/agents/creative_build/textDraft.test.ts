import { expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { AgentJobRow } from "../../queue.js";
import { runCreativeBuildJob } from "./index.js";

const { messages, attest } = vi.hoisted(() => ({ messages: vi.fn(), attest: vi.fn() }));
vi.mock("../../tools/anthropic.js", async original => ({
  ...await original<typeof import("../../tools/anthropic.js")>(), runAgentLoop: messages,
}));
vi.mock("../../creative/attest-asset-route.js", () => ({ attestCreativeAssetBytes: attest }));

it("recovers the exact text draft after an interrupted file attestation without another model call", async () => {
  const copy = { headline: "Planning checklist", body: "Measure each wall and record the access needed around storage.", call_to_action: "Review the layout." };
  messages.mockResolvedValue({ submitted: copy, usage: { costUsd: 0.01, inputTokens: 20, outputTokens: 40 } });
  attest.mockRejectedValueOnce(new Error("attestation interrupted")).mockResolvedValue(undefined);
  const generation = { id: "generation", client_id: "client", brief_id: "brief", media_type: "text", concept: null };
  const render = { id: "render", client_id: "client", job_id: "job", generation_id: "generation" };
  const brief = { id: "brief", client_id: "client", purpose: "client", media_type: "text", content_format: "single", proof_asset_id: null };
  const rows: Record<string, Record<string, unknown>> = { creative_generations: generation, creative_renders: render, client_briefs: brief };
  const assets: Record<string, unknown>[] = [];
  const upload = vi.fn(async () => ({ error: null }));
  const from = vi.fn((table: string) => {
    const query = {
      select: () => query, eq: () => query, in: () => query, throwOnError: () => query,
      maybeSingle: async () => ({ data: rows[table] ?? null }),
      then: (resolve: (result: unknown) => void) => resolve({ data: [], error: null }),
      limit: async () => ({ data: assets }),
      update: (values: Record<string, unknown>) => {
        const row = rows[table];
        if (!row) throw new Error(`Unexpected write to ${table}`);
        Object.assign(row, values);
        return query;
      },
      insert: (values: Record<string, unknown>) => {
        if (table === "client_media_assets") assets.push({ ...values, id: "asset" });
        return query;
      },
      single: async () => ({ data: { id: "asset" } }),
    };
    return query;
  });
  const db = { from, storage: { from: () => ({ upload }) } } as unknown as SupabaseClient;
  const config = { model: "claude-opus-5", conceptProvider: "openai", anthropicApiKeyByAgent: {} } as RuntimeConfig;
  const job: AgentJobRow = {
    id: "job", agent_key: "creative_build", client_id: "client", input_id: null, input_table: null,
    params: { render_id: "render" }, hard_budget_required: true, status: "running",
    attempts: 1, max_attempts: 3, lease_owner: "worker", lease_until: null,
  };
  const run = () => runCreativeBuildJob(db, config, { agent_key: "creative_build" } as AgentRow, job, Date.now() + 5000);
  await expect(run()).rejects.toThrow("attestation interrupted");
  expect(generation.concept).toEqual(copy);
  expect(await run()).toMatchObject({ ok: true });
  expect(messages).toHaveBeenCalledTimes(1);
  expect(messages).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-opus-5", enableWebSearch: false }));
  expect(from).not.toHaveBeenCalledWith("client_proof_assets");
  expect(upload).toHaveBeenCalledTimes(1);
  expect(assets).toEqual([expect.objectContaining({ id: "asset", client_id: "client", brief_id: "brief", review_status: "pending" })]);
  expect(render).toMatchObject({ asset_id: "asset", status: "done" });
  expect(generation).toMatchObject({ asset_id: "asset", brief_id: "brief", concept: copy, stage: "done" });
  expect(brief).toMatchObject({ status: "complete" });
});

it.each([true, false])("holds independent artwork before reading proof or calling a provider (enrolled=%s)", async enrolled => {
  messages.mockClear();
  const rows: Record<string, object> = {
    creative_renders: { id: "render", generation_id: "generation", reference_path: "excluded.png" },
    creative_generations: { brief_id: "brief", concept: { subject: "cached source" } },
    client_briefs: { id: "brief", media_type: "image", excluded_artwork_proof_id: "cleared-raw" },
  };
  const from = vi.fn((table: string) => {
    if (!rows[table]) throw new Error("Unexpected read: " + table);
    const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: rows[table] }) };
    return query;
  });
  const db = { from } as unknown as SupabaseClient;
  const job = { client_id: "client", params: { render_id: "render" }, hard_budget_required: enrolled } as AgentJobRow;
  await expect(runCreativeBuildJob(db, {} as RuntimeConfig, {} as AgentRow, job, Date.now() + 5000))
    .rejects.toThrow("verified per-call spending ceiling");
  expect(from.mock.calls.map(([table]) => table)).toEqual(Object.keys(rows));
  expect(messages).not.toHaveBeenCalled();
});
