import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../config.js";
import type { AgentRow } from "../orchestration/registry.js";
import type { AgentJobRow } from "../queue.js";
import { hasRunner } from "../orchestration/dispatch.js";
import { runGoogleReplySenderJob } from "./reply-job.js";

it("registers the Google reply runner but holds before any provider work while off", async () => {
  const insert = vi.fn(async () => ({ error: null }));
  const rpc = vi.fn();
  const sb = { from: () => ({ insert }), rpc } as unknown as SupabaseClient;
  const config = { googleReviewReplyEnabled: false } as RuntimeConfig;
  const job = { id: "job-1", agent_key: "google_reply_sender", client_id: "client-1",
    input_table: "google_review_replies", input_id: "reply-1" } as AgentJobRow;
  expect(hasRunner("google_reply_sender")).toBe(true);
  const result = await runGoogleReplySenderJob(sb, config, {} as AgentRow, job);
  expect(result).toMatchObject({ ok: false, hold: true, retryable: false });
  expect(insert).toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();
});
