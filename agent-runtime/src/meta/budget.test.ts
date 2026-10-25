import { describe, expect, it, vi } from "vitest";

import { MetaWriteError, updateAdSetDailyBudget } from "./ads.js";

/**
 * Changing an ad set's daily budget — G07.
 *
 * Two things are worth pinning: the minor-unit conversion, because getting
 * it wrong sets a one-pound budget and looks like the campaign stopped
 * working; and that the call cannot change whether money is moving, only how
 * much.
 */
const account = { accessToken: "tok", accountId: "act_1" };

function fetchMock(status = 200, body: unknown = { success: true }) {
  const impl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", impl);
  return impl;
}

describe("the unit", () => {
  it("sends minor units, so a hundred pounds is ten thousand", async () => {
    const impl = fetchMock();
    await updateAdSetDailyBudget(account, "23848", 100);
    const sent = JSON.parse((impl.mock.calls[0]![1] as RequestInit).body as string);
    expect(sent.daily_budget).toBe(10000);
  });

  it("rounds to the nearest minor unit rather than truncating", async () => {
    const impl = fetchMock();
    await updateAdSetDailyBudget(account, "23848", 33.335);
    const sent = JSON.parse((impl.mock.calls[0]![1] as RequestInit).body as string);
    expect(sent.daily_budget).toBe(3334);
  });

  it("refuses an amount below one currency unit as a conversion mistake", async () => {
    fetchMock();
    await expect(updateAdSetDailyBudget(account, "23848", 0.5))
      .rejects.toMatchObject({ retryable: false });
  });

  it("refuses nothing and negatives", async () => {
    fetchMock();
    for (const amount of [0, -5, Number.NaN]) {
      await expect(updateAdSetDailyBudget(account, "23848", amount))
        .rejects.toBeInstanceOf(MetaWriteError);
    }
  });
});

describe("what it can and cannot change", () => {
  it("posts to the ad set's own id, not an account edge", async () => {
    const impl = fetchMock();
    await updateAdSetDailyBudget(account, "23848", 50);
    expect(String(impl.mock.calls[0]![0])).toContain("/23848");
    expect(String(impl.mock.calls[0]![0])).not.toContain("act_1");
  });

  it("never sends a status, so it cannot activate or pause anything", async () => {
    const impl = fetchMock();
    await updateAdSetDailyBudget(account, "23848", 50);
    const sent = JSON.parse((impl.mock.calls[0]![1] as RequestInit).body as string);
    expect(Object.keys(sent)).toEqual(["daily_budget"]);
  });

  it("returns the ad set id, because Meta answers an update with no id", async () => {
    fetchMock(200, { success: true });
    expect(await updateAdSetDailyBudget(account, "23848", 50)).toEqual({ id: "23848" });
  });
});

describe("failing", () => {
  it("treats a network fault as retryable, because setting the same figure twice is harmless", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up"); }));
    await expect(updateAdSetDailyBudget(account, "23848", 50))
      .rejects.toMatchObject({ retryable: true });
  });

  it("does not retry a refusal Meta chose deliberately", async () => {
    fetchMock(400, { error: { message: "Invalid parameter" } });
    await expect(updateAdSetDailyBudget(account, "23848", 50))
      .rejects.toMatchObject({ retryable: false });
  });
});
