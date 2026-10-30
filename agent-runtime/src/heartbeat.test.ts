import { expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "./config.js";
import { makeHeartbeatWorkerId, startHeartbeat } from "./heartbeat.js";

it("assigns distinct identities to same-PID runtime replicas", async () => {
  const generatedA = makeHeartbeatWorkerId(1);
  const generatedB = makeHeartbeatWorkerId(1);
  expect(generatedA).not.toBe(generatedB);
  expect(generatedA).toMatch(/^agent-runtime:1:[0-9a-f-]{36}$/);

  const beats: Array<{ worker_id: string }> = [];
  const sb = {
    from(table: string) {
      if (table === "agent_runtime_heartbeats") {
        return { insert: async (row: { worker_id: string }) => {
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
  } finally {
    first.stop();
    second.stop();
  }
});
