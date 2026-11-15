import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../../config.js";
import type { ClaimedAction } from "./executor.js";

const { readAdSetBudget, updateAdSetDailyBudget } = vi.hoisted(() => ({
  readAdSetBudget: vi.fn(), updateAdSetDailyBudget: vi.fn(),
}));
vi.mock("../../meta/ads.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../meta/ads.js")>();
  return { ...real, readAdSetBudget, updateAdSetDailyBudget };
});
vi.mock("../../readiness/version.js", () => ({ deployedCommitSha: () => "a".repeat(40) }));

import { MetaWriteError } from "../../meta/ads.js";
import { changeAdSetBudget } from "./budget-change.js";

const action = { execution_id: "execution-1", approval_id: "approval-1",
  client_id: "client-1", campaign_id: "campaign-1", manifest_id: "manifest-1",
  action_key: "budget_change", destination: "Meta ad set 23848",
  artifact_version_hash: "b".repeat(64), scope: {}, attempt: 1 } as ClaimedAction;
const config = { campaignActionsEnabled: true, campaignActionOwnedClaimEnabled: true,
  campaignActionWorkerId: "agent-runtime:1:11111111-1111-4111-8111-111111111111" } as RuntimeConfig;

function db(recordError = false) {
  const rpc = vi.fn(async (name: string) => {
    if (name === "assert_budget_change_allowed_v6") return { data: {
      id: "change-1", client_id: "client-1", campaign_id: "campaign-1",
      ad_set_external_id: "23848", current_daily_budget: 50,
      proposed_daily_budget: 75, currency: "GBP",
    }, error: null };
    if (name === "meta_budget_credential_eligible_v6") return { data: true, error: null };
    if (name === "integration_secret") return { data: "token", error: null };
    if (name === "record_budget_change_applied" && recordError) {
      return { data: null, error: { message: "database unavailable" } };
    }
    return { data: true, error: null };
  });
  const sb = { rpc, from: () => ({ select: () => ({ eq: () => ({ eq: () => ({
    maybeSingle: async () => ({ data: { ad_account_id: "act_1" }, error: null }),
  }) }) }) }) } as unknown as SupabaseClient;
  return { sb, rpc };
}

beforeEach(() => {
  vi.clearAllMocks();
  readAdSetBudget.mockResolvedValueOnce({ id: "23848", accountId: "act_1",
    dailyBudgetMinor: 5000, currency: "GBP" })
    .mockResolvedValueOnce({ id: "23848", accountId: "act_1",
      dailyBudgetMinor: 7500, currency: "GBP" });
  updateAdSetDailyBudget.mockResolvedValue({ id: "23848" });
});

it("confirms account and old budget before write, then records exact readback", async () => {
  const { sb, rpc } = db();
  const result = await changeAdSetBudget(sb, config, action);
  expect(updateAdSetDailyBudget).toHaveBeenCalledWith(
    { accessToken: "token", accountId: "act_1" }, "23848", 75);
  expect(readAdSetBudget).toHaveBeenCalledTimes(2);
  expect(rpc).toHaveBeenCalledWith("assert_campaign_action_prewrite_v6", expect.anything());
  expect(rpc).toHaveBeenCalledWith("record_budget_change_applied", expect.anything());
  expect(result.result).toMatchObject({ provider_readback_minor: 7500 });
});

it("refuses a different live budget before any Meta write", async () => {
  readAdSetBudget.mockReset().mockResolvedValue({ id: "23848", accountId: "act_1",
    dailyBudgetMinor: 6000, currency: "GBP" });
  const { sb, rpc } = db();
  await expect(changeAdSetBudget(sb, config, action)).rejects.toThrow(/differs from the reviewed/);
  expect(updateAdSetDailyBudget).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalledWith("record_budget_change_applied", expect.anything());
});

it("requires the credential grant before a Meta read or write", async () => {
  const { sb, rpc } = db();
  rpc.mockImplementationOnce(async () => ({ data: {
    id: "change-1", client_id: "client-1", campaign_id: "campaign-1",
    ad_set_external_id: "23848", current_daily_budget: 50,
    proposed_daily_budget: 75, currency: "GBP",
  }, error: null })).mockImplementationOnce(async () => ({ data: false, error: null }));
  await expect(changeAdSetBudget(sb, config, action)).rejects.toThrow(/AAL2-reviewed Meta write credential/);
  expect(readAdSetBudget).not.toHaveBeenCalled();
  expect(updateAdSetDailyBudget).not.toHaveBeenCalled();
});

it("holds an unconfirmed provider response for manual reconciliation", async () => {
  updateAdSetDailyBudget.mockRejectedValue(new MetaWriteError("connection dropped", true));
  const { sb, rpc } = db();
  await expect(changeAdSetBudget(sb, config, action)).rejects.toMatchObject({
    retryable: false, message: expect.stringContaining("outcome is uncertain"),
  });
  expect(rpc).not.toHaveBeenCalledWith("record_budget_change_applied", expect.anything());
});

it("does not record success when provider readback differs", async () => {
  readAdSetBudget.mockReset().mockResolvedValueOnce({ id: "23848", accountId: "act_1",
    dailyBudgetMinor: 5000, currency: "GBP" })
    .mockResolvedValueOnce({ id: "23848", accountId: "act_1",
      dailyBudgetMinor: 7000, currency: "GBP" });
  const { sb, rpc } = db();
  await expect(changeAdSetBudget(sb, config, action)).rejects.toThrow(/readback differs/);
  expect(rpc).not.toHaveBeenCalledWith("record_budget_change_applied", expect.anything());
});

it("holds a confirmed write when local recording fails", async () => {
  const { sb } = db(true);
  await expect(changeAdSetBudget(sb, config, action)).rejects.toMatchObject({
    retryable: false,
    message: expect.stringContaining("Meta confirmed the budget, but recording it failed"),
  });
  expect(updateAdSetDailyBudget).toHaveBeenCalledTimes(1);
  expect(readAdSetBudget).toHaveBeenCalledTimes(2);
});
