import { describe, expect, it } from "vitest";
import { buildMarketPrompt, MARKET_SYSTEM, validateMarketSections } from "./index.js";

describe("Market source and scope boundary", () => {
  it("keeps an unqualified revenue target period unknown and requires direct citations", () => {
    const prompt = buildMarketPrompt({
      templates: [],
      context: {
        business_overview: null,
        ideal_customer: null,
        main_offer: null,
        competitors: null,
        brand_voice: null,
        proof_testimonials: null,
        current_marketing: null,
        sales_process: null,
        current_revenue: null,
        target_revenue: "R100 000",
      },
      input: {}, upstream: [], sectionBrief: "- market-size-and-share: Market size",
      submitToolName: "submit_analysis", extra: "",
    });
    expect(prompt).toContain("Target revenue: R100 000");
    expect(MARKET_SYSTEM).toContain("A revenue target without a stated period is ambiguous");
    expect(MARKET_SYSTEM).toContain("direct working source URL");
    expect(MARKET_SYSTEM).toContain("Do not state tax or legal thresholds");
    expect(MARKET_SYSTEM).toContain("current binding constraint is undetermined");
  });

  it("blocks an unlinked size or direction answer before persistence", () => {
    expect(validateMarketSections({
      "market-size-and-share": "A publisher reported a large total.",
      "market-direction": "See https://example.com/source",
    })).toMatch(/market-size-and-share/);
    expect(validateMarketSections({
      "market-size-and-share": "See https://example.com/size",
      "market-direction": "A publisher reported growth.",
    })).toMatch(/market-direction/);
    expect(validateMarketSections({
      "market-size-and-share": "See https://example.com/size",
      "market-direction": "See https://example.com/direction",
    })).toBeNull();
  });
});
