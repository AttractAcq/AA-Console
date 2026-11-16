import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../../config.js";
import { hasRunner } from "../../orchestration/dispatch.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { AgentJobRow } from "../../queue.js";
import { runCampaignBudgetReconciliationJob } from "./budget-reconciliation-job.js";

it("registers the read-only handler and rejects a job without an execution", async () => {
  const rpc = vi.fn();
  expect(hasRunner("campaign_budget_reconciler")).toBe(true);
  const result = await runCampaignBudgetReconciliationJob(
    { rpc } as unknown as SupabaseClient, {} as RuntimeConfig, {} as AgentRow,
    { id: "job-1", client_id: "client-1", input_table: "campaign_budget_changes",
      input_id: "change-1" } as AgentJobRow);
  expect(result).toMatchObject({ ok: false, retryable: false });
  expect(rpc).not.toHaveBeenCalled();
});
