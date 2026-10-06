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
    expect(v.detail).toMatch(/does not expire/);
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
    expect(v.detail).toMatch(/invalidated/);
  });

  it("treats a payload it cannot read as an error rather than as healthy", () => {
    for (const payload of [null, undefined, {}, { data: {} }, "nonsense"]) {
      expect(readTokenHealth(payload, NOW).usable).toBe(false);
    }
  });
});

describe("what gets written", () => {
  const healthy = readTokenHealth(valid({ expires_at: 0 }), NOW);
  const expiring = readTokenHealth(valid({ expires_at: inDays(2) }), NOW);
  const dead = readTokenHealth({ data: { is_valid: false } }, NOW);

  it("rescues an integration stuck in error when the token is fine again", () => {
    // The whole reason this agent exists. On 6 October an Instagram
    // integration sat in error for hours after the fault was fixed, because
    // nothing could say the token was fine now.
    expect(statusToWrite("error", healthy)).toBe("connected");
  });

  it("does not promote a never-used integration to active", () => {
    // active means an ingest has actually succeeded. A health check has not
    // ingested anything.
    expect(statusToWrite("connected", healthy)).toBe("connected");
    expect(statusToWrite("error", healthy)).not.toBe("active");
  });

  it("does not demote a working integration either", () => {
    expect(statusToWrite("active", healthy)).toBe("active");
  });

  it("marks a dead token as an error from any state", () => {
    for (const current of ["connected", "active", "expiring", "error"]) {
      expect(statusToWrite(current, dead)).toBe("error");
    }
  });

  it("marks expiring from any usable state, including active", () => {
    expect(statusToWrite("active", expiring)).toBe("expiring");
    expect(statusToWrite("connected", expiring)).toBe("expiring");
  });
});
