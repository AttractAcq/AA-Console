import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../config.js";
import { hasRunner } from "../orchestration/dispatch.js";
import type { AgentRow } from "../orchestration/registry.js";
import type { AgentJobRow } from "../queue.js";
import { runGoogleReplyReconciliationJob } from "./reply-reconciliation-job.js";

it("registers a GET-only handler and rejects a job without one exact attempt", async () => {
  const rpc = vi.fn();
  const sb = { rpc } as unknown as SupabaseClient;
  expect(hasRunner("google_reply_reconciler")).toBe(true);
  const result = await runGoogleReplyReconciliationJob(sb, {} as RuntimeConfig,
    {} as AgentRow, { id: "job-1", client_id: "client-1",
      input_table: "google_review_replies", input_id: "reply-1" } as AgentJobRow);
  expect(result).toMatchObject({ ok: false, retryable: false });
  expect(rpc).not.toHaveBeenCalled();
});
