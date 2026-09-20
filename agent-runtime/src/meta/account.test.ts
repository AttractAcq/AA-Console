import { describe, expect, it } from "vitest";
import { adAccountFor, isAdAccountId } from "./account.js";

describe("isAdAccountId", () => {
  it("accepts Meta's shape", () => {
    expect(isAdAccountId("act_1234567890")).toBe(true);
    expect(isAdAccountId("act_1")).toBe(true);
  });

  it("rejects everything else", () => {
    for (const bad of ["1234567890", "act_", "act_12ab", "ACT_123", "act 123", "", null, 42]) {
      expect(isAdAccountId(bad), String(bad)).toBe(false);
    }
  });
});

describe("adAccountFor", () => {
  it("prefers the column", () => {
    expect(adAccountFor({ ad_account_id: "act_1", credential_label: "act_2" })).toEqual({
      id: "act_1",
    });
  });

  it("falls back to a label that is already an account id", () => {
    expect(adAccountFor({ ad_account_id: null, credential_label: "act_99" })).toEqual({
      id: "act_99",
    });
  });

  // "Main account" is a name somebody typed. Treating it as an account is how
  // a write ends up addressed to nothing.
  it("refuses a label that is a human name", () => {
    const result = adAccountFor({ credential_label: "Main account" });
    expect(result).toEqual({ problem: expect.stringContaining("not an account") });
  });

  it("refuses a column that is not shaped like an account", () => {
    expect(adAccountFor({ ad_account_id: "1234567890" })).toEqual({
      problem: expect.stringContaining("act_1234567890"),
    });
  });

  it("does not fall back when the column is present but wrong", () => {
    const result = adAccountFor({ ad_account_id: "nonsense", credential_label: "act_7" });
    expect(result).toEqual({ problem: expect.stringContaining("not an ad account id") });
  });

  it("says so when there is nothing recorded at all", () => {
    expect(adAccountFor({})).toEqual({ problem: "This client has no ad account id recorded." });
    expect(adAccountFor({ ad_account_id: "  ", credential_label: "  " })).toEqual({
      problem: "This client has no ad account id recorded.",
    });
  });
});
