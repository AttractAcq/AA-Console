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

describe("the repurpose agent is wired in", () => {
  it("has a runner, so a queued repurpose can execute", () => {
    expect(hasRunner("repurpose")).toBe(true);
  });

  it("is in the registered set the worker claims from", () => {
    expect(registeredAgentKeys()).toContain("repurpose");
  });
});
