import { describe, expect, it } from "vitest";
import { adsManagerUrl, parseCountries, parseMetaObjectId } from "./metaBuild";

describe("parseCountries", () => {
  it("normalises case, spacing and repeats", () => {
    expect(parseCountries("za, gb ,ZA  us")).toEqual({ codes: ["ZA", "GB", "US"] });
  });

  it("names what is not a two-letter code", () => {
    expect(parseCountries("ZA, South Africa")).toEqual({
      problem: "SOUTH, AFRICA are not two-letter country codes.",
    });
    expect(parseCountries("ZAF")).toEqual({ problem: "ZAF is not a two-letter country code." });
  });

  it("refuses an empty list", () => {
    expect(parseCountries(" , ")).toEqual({ problem: "Name at least one country." });
  });
});

describe("adsManagerUrl", () => {
  it("opens the account on the built campaign", () => {
    expect(adsManagerUrl("act_123", "456")).toBe(
      "https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=123&selected_campaign_ids=456",
    );
  });
});

describe("parseMetaObjectId", () => {
  it("accepts a bare numeric id", () => {
    expect(parseMetaObjectId(" 120200123456789 ", "campaign id")).toEqual({ id: "120200123456789" });
  });

  it("asks for a value when the field is empty", () => {
    expect(parseMetaObjectId("  ", "campaign id")).toEqual({ problem: "Enter the campaign id." });
  });

  it("refuses an ad account id, which is the easiest thing to paste by mistake", () => {
    const result = parseMetaObjectId("act_123456", "campaign id");
    expect(result).toEqual({ problem: "That is an ad account id, not the campaign id." });
  });

  it("refuses a pasted URL rather than storing something reporting cannot match", () => {
    const result = parseMetaObjectId(
      "https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=123",
      "ad set id",
    );
    expect("problem" in result && result.problem).toContain("all digits");
  });
});
