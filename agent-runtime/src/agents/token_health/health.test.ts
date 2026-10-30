import { describe, expect, it } from "vitest";

import { EXPIRING_WITHIN_DAYS, readTokenHealth, statusToWrite } from "./health.js";

/** 1 January 2027, as a fixed point to measure expiries from. */
const NOW = Date.UTC(2027, 0, 1, 12, 0, 0);
const inDays = (days: number) => Math.floor((NOW + days * 86_400_000) / 1000);

const valid = (extra: Record<string, unknown> = {}) => ({
  data: { is_valid: true, ...extra },
});

describe("reading a healthy token", () => {
  it("is connected and usable when it does not expire", () => {
    // expires_at 0 is Meta's "never", not "expired at the epoch".
    const v = readTokenHealth(valid({ expires_at: 0 }), NOW);
    expect(v).toMatchObject({ status: "connected", usable: true, expiresAt: null });
    expect(v.detail).toMatch(/no expiry/);
    expect(v.detail).toMatch(/permissions are not verified/);
  });

  it("is connected when the expiry is comfortably away", () => {
    const v = readTokenHealth(valid({ expires_at: inDays(60) }), NOW);
    expect(v).toMatchObject({ status: "connected", usable: true });
    expect(v.expiresAt).toBe(new Date(NOW + 60 * 86_400_000).toISOString());
  });
});

describe("a token running out", () => {
  it("warns inside the window, and stays usable", () => {
    // The point of the warning is to act before the outage. An integration
    // that stops a week early because it was going to stop is the warning
    // causing the thing it warns about.
    const v = readTokenHealth(valid({ expires_at: inDays(3) }), NOW);
    expect(v).toMatchObject({ status: "expiring", usable: true });
    expect(v.detail).toMatch(/expires in 3 days/);
  });

  it("says under a day rather than 0 days", () => {
    const v = readTokenHealth(valid({ expires_at: inDays(0.5) }), NOW);
    expect(v.detail).toMatch(/under a day/);
  });

  it("is still only warning on the last day of the window", () => {
    expect(readTokenHealth(valid({ expires_at: inDays(EXPIRING_WITHIN_DAYS) }), NOW).status).toBe("expiring");
    expect(readTokenHealth(valid({ expires_at: inDays(EXPIRING_WITHIN_DAYS + 1) }), NOW).status).toBe("connected");
  });

  it("takes the nearer of the two clocks", () => {
    // A long-lived token with short data access stops returning insights
    // while still reporting itself valid, so the nearer one is the one that
    // bites.
    const v = readTokenHealth(
      valid({ expires_at: inDays(90), data_access_expires_at: inDays(2) }),
      NOW,
    );
    expect(v).toMatchObject({ status: "expiring" });
    expect(v.detail).toMatch(/2 days/);
  });
});

describe("a token that is gone", () => {
  it("is an error once the expiry has passed", () => {
    const v = readTokenHealth(valid({ expires_at: inDays(-1) }), NOW);
    expect(v).toMatchObject({ status: "error", usable: false });
    expect(v.detail).toMatch(/expired/);
  });

  it("is an error when Meta says it is not valid", () => {
    const v = readTokenHealth({ data: { is_valid: false } }, NOW);
    expect(v).toMatchObject({ status: "error", usable: false });
  });

  it("is an error when Meta reports one inside a 200", () => {
    // A revoked token comes back as a successful request carrying an error.
    // A reader that only checks the HTTP status calls it healthy.
    const v = readTokenHealth(
      { data: { is_valid: true, error: { code: 190, message: "Session has been invalidated." } } },
      NOW,
    );
    expect(v).toMatchObject({ status: "error", usable: false });
    expect(v.detail).toMatch(/no longer valid/);
  });

  it("never copies a provider OAuth error message into stored health detail", () => {
    const marker = "credential-marker-never-persist";
    const verdict = readTokenHealth({ data: {
      is_valid: false, error: { code: 190, message: `Invalid token ${marker}` },
    } }, NOW);
    expect(verdict).toMatchObject({ status: "error", usable: false });
    expect(JSON.stringify(verdict)).not.toContain(marker);
  });

  it("does not treat a malformed or missing verdict as revocation", () => {
    for (const payload of [null, undefined, {}, { data: {} }, "nonsense", { data: { is_valid: "false" } }]) {
      expect(() => readTokenHealth(payload, NOW)).toThrow(/did not establish token validity/);
    }
  });

  it("does not treat a non-auth error in a 200 response as revocation", () => {
    for (const isValid of [true, false]) {
      expect(() => readTokenHealth(
        { data: { is_valid: isValid, error: { code: 17, message: "Rate limited" } } }, NOW,
      )).toThrow(/non-auth error/);
    }
  });

  it("recognizes a top-level OAuth token error as invalid", () => {
    expect(readTokenHealth({ error: { code: 190, message: "Invalid OAuth token" } }, NOW))
      .toMatchObject({ status: "error", usable: false });
  });
});

describe("what gets written", () => {
  const healthy = readTokenHealth(valid({ expires_at: 0 }), NOW);
  const expiring = readTokenHealth(valid({ expires_at: inDays(2) }), NOW);
  const dead = readTokenHealth({ data: { is_valid: false } }, NOW);

  it("never reactivates terminal states based on token validity alone", () => {
    expect(statusToWrite("error", healthy)).toBe("error");
    expect(statusToWrite("revoked", healthy)).toBe("revoked");
    expect(statusToWrite("expired", healthy)).toBe("expired");
  });

  it("does not promote a never-used integration to active", () => {
    // active means an ingest has actually succeeded. A health check has not
    // ingested anything.
    expect(statusToWrite("connected", healthy)).toBe("connected");
    expect(statusToWrite("expiring", healthy)).toBe("expiring");
  });

  it("does not demote a working integration either", () => {
    expect(statusToWrite("active", healthy)).toBe("active");
  });

  it("marks a dead token as an error from a checkable state", () => {
    for (const current of ["connected", "active", "expiring"]) {
      expect(statusToWrite(current, dead)).toBe("error");
    }
    expect(statusToWrite("revoked", dead)).toBe("revoked");
    expect(statusToWrite("expired", dead)).toBe("expired");
  });

  it("records expiry without writing expiring before migration 291 is released", () => {
    expect(statusToWrite("active", expiring)).toBe("active");
    expect(statusToWrite("connected", expiring)).toBe("connected");
    expect(statusToWrite("expiring", expiring)).toBe("expiring");
  });

  it("fails closed on an unknown integration state", () => {
    expect(statusToWrite("surprise", healthy)).toBe("error");
  });
});
