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

  it("has no runner for market, by design, until it has somewhere to show its output", () => {
    expect(hasRunner("market")).toBe(false);
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
    expect(keys).not.toContain("market");
  });
});
