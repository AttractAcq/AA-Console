import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../config.js";
import type { AgentRow } from "../orchestration/registry.js";
import type { AgentJobRow } from "../queue.js";
import { hasRunner } from "../orchestration/dispatch.js";
import { runGoogleProfileFieldJob } from "./google-profile-job.js";

it("registers the Google profile runner but holds before any provider work while off", async () => {
  const insert = vi.fn(async () => ({ error: null }));
  const rpc = vi.fn();
  const sb = { from: () => ({ insert }), rpc } as unknown as SupabaseClient;
  const config = { googleProfileFieldWriteEnabled: false } as RuntimeConfig;
  const job = { id: "job-1", agent_key: "google_profile_field_writer", client_id: "client-1",
    input_table: "google_profile_changes", input_id: "change-1" } as AgentJobRow;
  expect(hasRunner("google_profile_field_writer")).toBe(true);
  const result = await runGoogleProfileFieldJob(sb, config, {} as AgentRow, job);
  expect(result).toMatchObject({ ok: false, hold: true, retryable: false });
  expect(insert).toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();
});
