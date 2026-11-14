import { afterEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "./config.js";
import { makeHeartbeatWorkerId, startHeartbeat } from "./heartbeat.js";

afterEach(() => vi.unstubAllEnvs());

it("assigns distinct identities to same-PID runtime replicas", async () => {
  const generatedA = makeHeartbeatWorkerId(1);
  const generatedB = makeHeartbeatWorkerId(1);
  expect(generatedA).not.toBe(generatedB);
  expect(generatedA).toMatch(/^agent-runtime:1:[0-9a-f-]{36}$/);

  const beats: Array<{ worker_id: string; metadata: Record<string, unknown> }> = [];
  const sb = {
    from(table: string) {
      if (table === "agent_runtime_heartbeats") {
        return { insert: async (row: { worker_id: string; metadata: Record<string, unknown> }) => {
          beats.push(row);
          return { error: null };
        } };
      }
      return {
        select: () => ({
          eq: async () => ({ count: 0 }),
          in: async () => ({ count: 0 }),
        }),
      };
    },
  } as unknown as SupabaseClient;
  const config = { enabled: true, model: "test-model" } as RuntimeConfig;
  const first = startHeartbeat(sb, config, 2);
  const second = startHeartbeat(sb, config, 2);
  try {
    await vi.waitFor(() => expect(beats).toHaveLength(2));
    expect(beats[0]?.worker_id).not.toBe(beats[1]?.worker_id);
    expect(first.workerId).toBe(beats[0]?.worker_id);
    expect(beats[0]?.metadata.handlers).toEqual({
      proof_publish: "proof_distribution",
      page_deploy: "website_studio",
      lead_message: "sales_os",
      budget_change: "meta_ads_studio",
    });
    expect(beats[0]?.metadata.holds).toHaveProperty("campaignActions");
  } finally {
    first.stop();
    second.stop();
  }
});

it("advertises the owned claim only for a deployed build with matching registered handlers", async () => {
  const sha = "c".repeat(40);
  vi.stubEnv("RAILWAY_GIT_COMMIT_SHA", sha);
  const handlers = {
    proof_publish: "proof_distribution", page_deploy: "website_studio",
    lead_message: "sales_os", budget_change: "meta_ads_studio",
  };
  const beats: Array<{ version: string; metadata: { holds: Record<string, string> } }> = [];
  const sb = { from(table: string) {
    if (table === "agent_runtime_heartbeats") return { insert: async (row: typeof beats[number]) => {
      beats.push(row); return { error: null };
    } };
    if (table === "campaign_action_executors") return { select: () => ({ in: async () => ({
      data: Object.entries(handlers).map(([action_key, executor_module]) => ({
        action_key, executor_module, supported: true, handler_attested_sha: sha,
      })), error: null,
    }) }) };
    return { select: () => ({ eq: async () => ({ count: 0 }),
      in: async () => ({ count: 0 }) }) };
  } } as unknown as SupabaseClient;
  const config = { enabled: true, model: "test", campaignActionsEnabled: true,
    campaignActionOwnedClaimEnabled: true } as RuntimeConfig;
  const handle = startHeartbeat(sb, config, 1);
  try {
    await vi.waitFor(() => expect(beats).toHaveLength(1));
    expect(beats[0]?.version).toBe(sha);
    expect(beats[0]?.metadata.holds).toEqual({});
  } finally { handle.stop(); }
});
