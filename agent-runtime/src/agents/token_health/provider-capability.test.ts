import { describe, expect, it } from "vitest";
import { evaluateProviderCapability, MAX_CAPABILITY_EVIDENCE_TTL_MS,
  type ProviderCapabilityEvidence, type ProviderCapabilityKey } from "./provider-capability.js";

const NOW = Date.UTC(2027, 0, 1, 12);
const key: ProviderCapabilityKey = {
  clientId: "11111111-1111-4111-8111-111111111111",
  integrationId: "22222222-2222-4222-8222-222222222222",
  credentialVersion: "rotation-3",
  provider: "meta",
  accountRef: "act_123",
  actionKey: "meta.account.read",
};
const evidence: ProviderCapabilityEvidence = {
  key: { ...key }, source: "provider_read_probe",
  observedAt: new Date(NOW).toISOString(), ttlMs: 60_000,
  credentialState: "eligible", tokenExpiresAt: new Date(NOW + 30 * 86_400_000).toISOString(),
  checks: { token: "verified", app: "verified", scopes: "verified", account: "verified" },
};

describe("exact provider capability evidence", () => {
  it("verifies only a fresh direct read and returns a copied, secret-free exact key", () => {
    const result = evaluateProviderCapability(key, evidence, NOW);
    expect(result).toEqual({ key, state: "verified", reason: "exact_read_verified",
      observedAt: new Date(NOW).toISOString(),
      evidenceFreshUntil: new Date(NOW + 60_000).toISOString() });
    expect(result.key).not.toBe(key);
    expect(result.key).not.toBe(evidence.key);
    const withSecret = { ...evidence, accessToken: "private-token-value",
      providerBody: { authorization: "Bearer private-token-value" } };
    expect(JSON.stringify(evaluateProviderCapability(key, withSecret, NOW)))
      .not.toContain("private-token-value");
  });

  it.each([
    ["clientId", "33333333-3333-4333-8333-333333333333"],
    ["integrationId", "44444444-4444-4444-8444-444444444444"],
    ["credentialVersion", "rotation-4"],
    ["provider", "instagram"],
    ["accountRef", "act_999"],
    ["actionKey", "meta.ads.build"],
  ] as const)("blocks an evidence %s mismatch", (field, value) => {
    const mismatched = { ...evidence, key: { ...key, [field]: value } };
    expect(evaluateProviderCapability(key, mismatched, NOW)).toMatchObject({
      state: "blocked", reason: "scope_mismatch", key,
    });
  });

  it("does not turn configured/connected metadata into provider rights", () => {
    const metadata = { ...evidence, source: "configured_metadata" as const };
    expect(evaluateProviderCapability(key, metadata, NOW)).toMatchObject({
      state: "unknown", reason: "metadata_only",
    });
    expect(evaluateProviderCapability(key, null, NOW)).toMatchObject({
      state: "unknown", reason: "missing_evidence",
    });
  });

  it("keeps every write and unimplemented provider unknown, even with all checks verified", () => {
    const writeKey = { ...key, actionKey: "meta.ads.build" };
    const writeEvidence = { ...evidence, key: writeKey };
    expect(evaluateProviderCapability(writeKey, writeEvidence, NOW)).toMatchObject({
      state: "unknown", reason: "unimplemented_action",
    });
    const genericKey = { ...key, provider: "google_ads", actionKey: "google_ads.account.read" };
    expect(evaluateProviderCapability(genericKey, { ...evidence, key: genericKey }, NOW))
      .toMatchObject({ state: "unknown", reason: "unimplemented_action" });
    expect(evaluateProviderCapability(key, { ...evidence, source: "provider_action_preflight" }, NOW))
      .toMatchObject({ state: "unknown", reason: "unimplemented_source" });
  });

  it("blocks a revoked or expired credential before evaluating read rights", () => {
    expect(evaluateProviderCapability(key, { ...evidence, credentialState: "revoked" }, NOW + 86_400_000))
      .toMatchObject({ state: "blocked", reason: "credential_revoked" });
    expect(evaluateProviderCapability(key, { ...evidence, credentialState: "unknown" }, NOW))
      .toMatchObject({ state: "unknown", reason: "credential_state_unknown" });
    expect(evaluateProviderCapability(key, {
      ...evidence, tokenExpiresAt: new Date(NOW).toISOString(),
    }, NOW)).toMatchObject({ state: "blocked", reason: "credential_expired" });
    expect(evaluateProviderCapability(key, {
      ...evidence, tokenExpiresAt: new Date(NOW + 10_000).toISOString(),
    }, NOW)).toMatchObject({
      state: "verified", evidenceFreshUntil: new Date(NOW + 10_000).toISOString(),
    });
  });

  it("rejects stale, future, overlong, zero and malformed observation windows", () => {
    expect(evaluateProviderCapability(key, evidence, NOW + 60_000))
      .toMatchObject({ state: "unknown", reason: "stale_evidence" });
    expect(evaluateProviderCapability(key, { ...evidence,
      observedAt: new Date(NOW + 1).toISOString() }, NOW))
      .toMatchObject({ state: "unknown", reason: "invalid_evidence_time" });
    for (const ttlMs of [0, -1, MAX_CAPABILITY_EVIDENCE_TTL_MS + 1, Number.POSITIVE_INFINITY]) {
      expect(evaluateProviderCapability(key, { ...evidence, ttlMs }, NOW))
        .toMatchObject({ state: "unknown", reason: "invalid_evidence_time" });
    }
    expect(evaluateProviderCapability(key, { ...evidence, observedAt: "not-a-date" }, NOW))
      .toMatchObject({ state: "unknown", reason: "invalid_evidence_time" });
    expect(evaluateProviderCapability(key, { ...evidence, observedAt: "2027-01-01" }, NOW))
      .toMatchObject({ state: "unknown", reason: "invalid_evidence_time" });
    expect(evaluateProviderCapability(key, { ...evidence, tokenExpiresAt: "not-a-date" }, NOW))
      .toMatchObject({ state: "unknown", reason: "invalid_evidence_time" });
  });

  it("requires provider-confirmed token, app, scopes and exact Meta account read", () => {
    for (const field of ["token", "app", "scopes", "account"] as const) {
      expect(evaluateProviderCapability(key, { ...evidence,
        checks: { ...evidence.checks, [field]: "unknown" } }, NOW))
        .toMatchObject({ state: "unknown", reason: "provider_uncertain" });
      expect(evaluateProviderCapability(key, { ...evidence,
        checks: { ...evidence.checks, [field]: "blocked" } }, NOW))
        .toMatchObject({ state: "blocked", reason: "provider_denied" });
    }
    expect(evaluateProviderCapability(key, { ...evidence, checks: null } as unknown as ProviderCapabilityEvidence, NOW))
      .toMatchObject({ state: "unknown", reason: "provider_uncertain" });
  });

  it("allows only the exact Business Profile location read without pretending posting scopes were checked", () => {
    const locationKey = { ...key, provider: "google_business",
      accountRef: "accounts/a1/locations/l2", actionKey: "google_business.location.read" };
    const locationEvidence = { ...evidence, key: locationKey,
      checks: { token: "verified" as const, app: "unknown" as const,
        scopes: "unknown" as const, account: "verified" as const } };
    expect(evaluateProviderCapability(locationKey, locationEvidence, NOW))
      .toMatchObject({ state: "verified", reason: "exact_read_verified" });
    const postKey = { ...locationKey, actionKey: "google_business.local_post.create" };
    expect(evaluateProviderCapability(postKey, { ...locationEvidence, key: postKey }, NOW))
      .toMatchObject({ state: "unknown", reason: "unimplemented_action" });
  });
});
