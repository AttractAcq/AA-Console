import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../config.js";
import { hasRunner } from "../orchestration/dispatch.js";
import type { AgentRow } from "../orchestration/registry.js";
import type { AgentJobRow } from "../queue.js";
import { runGoogleProfileReconciliationJob } from "./google-profile-reconciliation-job.js";

it("registers the read-only handler and rejects a job without an exact attempt", async () => {
  const rpc = vi.fn();
  const sb = { rpc } as unknown as SupabaseClient;
  expect(hasRunner("google_profile_field_reconciler")).toBe(true);
  const result = await runGoogleProfileReconciliationJob(sb, {} as RuntimeConfig,
    {} as AgentRow, { id: "job-1", client_id: "client-1",
      input_table: "google_profile_changes", input_id: "change-1" } as AgentJobRow);
  expect(result).toMatchObject({ ok: false, retryable: false });
  expect(rpc).not.toHaveBeenCalled();
});
