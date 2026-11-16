import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, expect, it, vi } from "vitest";
import { reconcileUncertainBudget } from "./budget-reconciler.js";

const { accountFor, readAdSetBudget } = vi.hoisted(() => ({
  accountFor: vi.fn(), readAdSetBudget: vi.fn(),
}));
vi.mock("./budget-change.js", () => ({ accountFor }));
vi.mock("../../meta/ads.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../meta/ads.js")>(), readAdSetBudget,
}));

const target = { execution_id: "execution-1", client_id: "client-1",
  ad_set_external_id: "23848", currency: "USD",
  prior_daily_budget: "10", proposed_daily_budget: "20" };

beforeEach(() => {
  vi.clearAllMocks();
  accountFor.mockResolvedValue({ accessToken: "secret", accountId: "act_1" });
  readAdSetBudget.mockResolvedValue({ id: "23848", accountId: "act_1",
    currency: "USD", dailyBudgetMinor: 2000 });
});

it("records one read-only observation without repeating a budget write", async () => {
  const rpc = vi.fn(async (name: string) => name === "campaign_budget_readback_target_v6"
    ? { data: target, error: null } : { data: "matches_proposed", error: null });
  const result = await reconcileUncertainBudget({ rpc } as unknown as SupabaseClient,
    "execution-1", "client-1");
  expect(result).toEqual({ status: "matches_proposed" });
  expect(readAdSetBudget).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith("record_campaign_budget_readback_v6",
    expect.objectContaining({ p_execution_id: "execution-1", p_account_id: "act_1",
      p_observed_daily_budget_minor: 2000 }));
});

it("holds a cross-client or changed-account target before recording", async () => {
  const rpc = vi.fn().mockResolvedValue({ data: { ...target, client_id: "other-client" }, error: null });
  expect(await reconcileUncertainBudget({ rpc } as unknown as SupabaseClient,
    "execution-1", "client-1")).toMatchObject({ status: "held" });
  expect(readAdSetBudget).not.toHaveBeenCalled();

  rpc.mockResolvedValue({ data: target, error: null });
  accountFor.mockResolvedValueOnce({ accessToken: "secret", accountId: "act_1" })
    .mockResolvedValueOnce({ accessToken: "new-secret", accountId: "act_1" });
  expect(await reconcileUncertainBudget({ rpc } as unknown as SupabaseClient,
    "execution-1", "client-1")).toMatchObject({ status: "held" });
  expect(rpc).not.toHaveBeenCalledWith("record_campaign_budget_readback_v6", expect.anything());
});

it("refuses a provider response for a different account", async () => {
  const rpc = vi.fn().mockResolvedValue({ data: target, error: null });
  readAdSetBudget.mockResolvedValue({ id: "23848", accountId: "act_2",
    currency: "USD", dailyBudgetMinor: 2000 });
  expect(await reconcileUncertainBudget({ rpc } as unknown as SupabaseClient,
    "execution-1", "client-1")).toMatchObject({ status: "held" });
  expect(rpc).not.toHaveBeenCalledWith("record_campaign_budget_readback_v6", expect.anything());
});
