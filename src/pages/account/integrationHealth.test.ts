import { describe, expect, it } from "vitest";
import { integrationCapabilitySummary } from "./integrationHealth";

const NOW = Date.UTC(2027, 0, 1);

describe("Account integration capability labels", () => {
  it.each(["error", "expired", "revoked"])("marks %s as blocked", (status) => {
    expect(integrationCapabilitySummary("meta", status, null, NOW)).toMatch(/^Blocked/);
  });

  it("marks a known past expiry blocked even when status still says connected", () => {
    expect(integrationCapabilitySummary("meta", "connected", "2026-12-31T00:00:00Z", NOW))
      .toMatch(/^Blocked/);
  });

  it("requires a known future expiry for expiring and rejects unknown statuses", () => {
    expect(integrationCapabilitySummary("meta", "expiring", null, NOW)).toMatch(/^Blocked/);
    expect(integrationCapabilitySummary("meta", "expiring", "2026-12-31T00:00:00Z", NOW)).toMatch(/^Blocked/);
    expect(integrationCapabilitySummary("meta", "pending", null, NOW)).toMatch(/^Blocked/);
    expect(integrationCapabilitySummary("meta", "expiring", "2027-01-02T00:00:00Z", NOW)).toMatch(/not verified/);
  });

  it.each([
    ["meta", /Account identity, required scopes/],
    ["instagram", /Account identity, required scopes/],
    ["google_business", /Exact location access/],
    ["google_ads", /developer token, customer access/],
    ["resend", /runtime email key/],
    ["other", /No provider-specific/],
  ])("keeps %s action capability unverified", (provider, pattern) => {
    expect(integrationCapabilitySummary(provider, "connected", null, NOW)).toMatch(pattern);
  });
});
