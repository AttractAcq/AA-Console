import { describe, expect, it } from "vitest";
import { hasRunner, registeredAgentKeys } from "./dispatch.js";

describe("dispatch registry", () => {
  it("registers a runner for every shipped agent", () => {
    for (const key of [
      "icp",
      "competitor",
      "association",
      "campaign_intel",
      "brand_strategy",
      "offer_strategy",
      "money_model",
      "ideation",
      "brief",
    ]) {
      expect(hasRunner(key)).toBe(true);
    }
  });

  it("has a runner for market, which now has an Intelligence tab to show it", () => {
    expect(hasRunner("market")).toBe(true);
  });

  it("has no runner for an unregistered agent key", () => {
    expect(hasRunner("not_a_real_agent")).toBe(false);
  });

  it("registeredAgentKeys matches exactly what hasRunner reports", () => {
    const keys = registeredAgentKeys();
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(hasRunner(key)).toBe(true);
    }
  });
});

describe("the video build agent is wired in", () => {
  it("has a runner, so a queued reel can be claimed", () => {
    expect(hasRunner("video_build")).toBe(true);
    expect(registeredAgentKeys()).toContain("video_build");
  });
});

describe("the repurpose agent is wired in", () => {
  it("has a runner, so a queued repurpose can execute", () => {
    expect(hasRunner("repurpose")).toBe(true);
  });

  it("is in the registered set the worker claims from", () => {
    expect(registeredAgentKeys()).toContain("repurpose");
  });
});

describe("the video edit agent is wired in", () => {
  it("has a runner, so a queued cut can be claimed", () => {
    expect(hasRunner("video_edit")).toBe(true);
    expect(registeredAgentKeys()).toContain("video_edit");
  });
});

describe("the spend cap stops a job before the runner, not inside it", () => {
  // The architectural claim worth pinning. Checking in dispatchJob is what
  // makes an agent added later bounded whether or not it thinks to ask; a
  // check inside each runner is a check somebody eventually forgets.
  const jobFor = (clientId: string) =>
    ({ id: "job-1", agent_key: "ideation", client_id: clientId, input_table: null, input_id: null }) as never;

  const sbWithCap = (capped: boolean, cap: number, spent: number) =>
    ({
      rpc: async (name: string) => {
        if (name !== "client_budget_state") throw new Error(`unexpected rpc ${name}`);
        return { data: [{ capped, cap_usd: cap, spent_usd: spent, remaining_usd: cap - spent }], error: null };
      },
    }) as never;

  it("refuses without calling the runner when the client is over", async () => {
    const { dispatchJob } = await import("./dispatch.js");
    const result = await dispatchJob(
      sbWithCap(true, 25, 25),
      { model: "claude-opus-5" } as never,
      { agent_key: "ideation" } as never,
      jobFor("client-over"),
    );
    expect(result.ok).toBe(false);
    // Not retryable: a retry spends the money the cap just refused.
    expect(result.retryable).toBe(false);
    expect(result.failureMessage).toMatch(/cap for the month/);
  });

  it("holds the job rather than failing it", async () => {
    // A cap is "not now", not "something broke". Failed meant the slot
    // failed with it and nothing came back when the cap was raised or the
    // month rolled, so a cap reached on the 3rd threw away the rest of that
    // client's engine work.
    const { dispatchJob } = await import("./dispatch.js");
    const result = await dispatchJob(
      sbWithCap(true, 25, 25),
      { model: "claude-opus-5" } as never,
      { agent_key: "ideation" } as never,
      jobFor("client-over"),
    );
    expect(result.hold).toBe(true);
  });

  it("does not hold a job that failed for any other reason", async () => {
    const { dispatchJob } = await import("./dispatch.js");
    const result = await dispatchJob(
      sbWithCap(false, 0, 0),
      { model: "claude-opus-5" } as never,
      { agent_key: "not_a_real_agent" } as never,
      jobFor("client-uncapped"),
    ).catch((error: unknown) => ({ hold: undefined, failureMessage: String(error) }));
    expect(result.hold).toBeFalsy();
  });

  it("does not refuse a client with no cap set", async () => {
    const { dispatchJob } = await import("./dispatch.js");
    // No cap means the runner is reached. ideation then fails on its own
    // terms against this stub, which is the point: the budget did not stop it.
    const result = await dispatchJob(
      sbWithCap(false, 0, 9999),
      { model: "claude-opus-5" } as never,
      { agent_key: "ideation" } as never,
      jobFor("client-uncapped"),
    ).catch((error: unknown) => ({ ok: false, retryable: false, failureMessage: String(error) }));
    expect(result.failureMessage ?? "").not.toMatch(/cap for the month/);
  });
});
