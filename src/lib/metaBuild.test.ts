import { describe, expect, it } from "vitest";
import { adsManagerUrl, parseCountries } from "./metaBuild";

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
