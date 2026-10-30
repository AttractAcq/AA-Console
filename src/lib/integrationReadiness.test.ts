import { describe, expect, it } from "vitest";
import {
  integrationRowsAreValid,
  providerReadiness,
  type IntegrationEvidence,
} from "./integrationReadiness";

const NOW = Date.parse("2026-10-30T12:00:00Z");

function row(provider: "meta" | "instagram", client_id = "client-a"): IntegrationEvidence {
  return {
    client_id,
    provider,
    credential_secret_id: "vault-ref",
    credential_label: provider === "meta" ? "act_123" : "17841400000000000",
    ad_account_id: provider === "meta" ? "act_123" : null,
    status: "active",
    token_expires_at: "2026-11-01T00:00:00Z",
    last_checked_at: "2026-10-30T11:00:00Z",
    ingest_enabled: true,
  };
}

describe("provider onboarding evidence is narrower than a stored integration", () => {
  it("keeps account access, scopes, action rights and token validity unknown for an apparently healthy Meta row", () => {
    const result = providerReadiness("meta", [row("meta")], "client-a", NOW);
    expect(result.overall).toBe("unknown");
    expect(result.credential.state).toBe("unknown");
    expect(result.account.state).toBe("unknown");
    expect(result.scopes.state).toBe("unknown");
    expect(result.action.state).toBe("unknown");
    expect(result.dailySync.state).toBe("unknown");
  });

  it("does not borrow a healthy provider row from another client", () => {
    const rows = [row("meta", "client-a"), { ...row("meta", "client-b"), status: "revoked" }];
    expect(providerReadiness("meta", rows, "client-a", NOW).overall).toBe("unknown");
    expect(providerReadiness("meta", rows, "client-b", NOW).credential).toMatchObject({ state: "blocked" });
    expect(providerReadiness("instagram", rows, "client-a", NOW).overall).toBe("blocked");
  });

  it.each(["error", "expired", "revoked", "expiring", "pending"])(
    "blocks %s status instead of inferring usability",
    (status) => expect(providerReadiness("meta", [{ ...row("meta"), status }], "client-a", NOW).credential.state)
      .toBe("blocked"),
  );

  it("blocks an expired or malformed expiry despite an active status", () => {
    for (const token_expires_at of ["2026-10-30T11:59:59Z", "not-a-date"]) {
      expect(providerReadiness("meta", [{ ...row("meta"), token_expires_at }], "client-a", NOW).credential.state)
        .toBe("blocked");
    }
  });

  it("blocks a missing Vault reference or ambiguous client/provider pair", () => {
    expect(providerReadiness("meta", [{ ...row("meta"), credential_secret_id: null }], "client-a", NOW).credential.state)
      .toBe("blocked");
    expect(providerReadiness("meta", [row("meta"), row("meta")], "client-a", NOW).overall)
      .toBe("blocked");
  });

  it("checks exact account shapes but does not call a well-shaped ID verified", () => {
    expect(providerReadiness("meta", [{ ...row("meta"), ad_account_id: "Main account" }], "client-a", NOW).account.state)
      .toBe("blocked");
    expect(providerReadiness("instagram", [{ ...row("instagram"), credential_label: "IG profile" }], "client-a", NOW).account.state)
      .toBe("blocked");
    expect(providerReadiness("instagram", [row("instagram")], "client-a", NOW).account.state)
      .toBe("unknown");
    expect(providerReadiness("meta", [{ ...row("meta"), ad_account_id: "  ", credential_label: "act_123" }], "client-a", NOW).account.state)
      .toBe("unknown");
  });

  it("blocks daily sync when it is off without making provider rights a write action", () => {
    const result = providerReadiness("meta", [{ ...row("meta"), ingest_enabled: false }], "client-a", NOW);
    expect(result.dailySync.state).toBe("blocked");
    expect(result.action.state).toBe("unknown");
  });

  it("does not describe configured-on sync as runnable when the credential is revoked", () => {
    const result = providerReadiness("meta", [{ ...row("meta"), status: "revoked" }], "client-a", NOW);
    expect(result.dailySync).toMatchObject({ state: "blocked" });
    expect(result.dailySync.reason).toMatch(/configured on, but the credential or account is blocked/);
  });
});

describe("integration read boundary", () => {
  it("accepts only complete rows for the requested client", () => {
    expect(integrationRowsAreValid([row("meta")], "client-a")).toBe(true);
    expect(integrationRowsAreValid([row("meta", "client-b")], "client-a")).toBe(false);
    expect(integrationRowsAreValid([{ provider: "meta" }], "client-a")).toBe(false);
    expect(integrationRowsAreValid(null, "client-a")).toBe(false);
  });
});
