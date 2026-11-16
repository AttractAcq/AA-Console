import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../config.js";
import type { AgentRow } from "../orchestration/registry.js";
import type { AgentJobRow } from "../queue.js";
import { hasRunner } from "../orchestration/dispatch.js";
import { runMetaProfileFieldJob } from "./meta-profile-job.js";

it("registers the Meta Page writer but holds before any credential or provider call while off", async () => {
  const insert = vi.fn(async () => ({ error: null }));
  const rpc = vi.fn();
  const sb = { from: () => ({ insert }), rpc } as unknown as SupabaseClient;
  const config = { metaProfileFieldWriteEnabled: false } as RuntimeConfig;
  const job = { id: "job-1", agent_key: "meta_profile_field_writer",
    client_id: "client-1", input_table: "meta_profile_changes",
    input_id: "change-1" } as AgentJobRow;
  expect(hasRunner("meta_profile_field_writer")).toBe(true);
  const result = await runMetaProfileFieldJob(sb, config, {} as AgentRow, job);
  expect(result).toMatchObject({ ok: false, hold: true, retryable: false });
  expect(insert).toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();
});
