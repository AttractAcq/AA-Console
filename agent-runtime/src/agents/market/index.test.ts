import { describe, expect, it } from "vitest";
import { buildMarketPrompt, MARKET_SYSTEM, validateMarketSections } from "./index.js";

describe("Market source and scope boundary", () => {
  it("keeps an unqualified revenue target period unknown and requires direct citations", () => {
    const prompt = buildMarketPrompt({
      templates: [
        { item_key: "constraint-diagnosis", item_type: "section", title: "Constraint", description: "Be decisive rather than balanced.", display_order: 1 },
        { item_key: "market-size-and-share", item_type: "section", title: "Share", description: "Give the reachable market and share required.", display_order: 2 },
      ],
      context: {
        business_overview: null,
        ideal_customer: null,
        main_offer: null,
        competitors: null,
        brand_voice: "PROVIDER_VOICE_SENTINEL",
        proof_testimonials: "PROVIDER_PROOF_SENTINEL",
        current_marketing: null,
        sales_process: null,
        current_revenue: null,
        target_revenue: "R100 000",
      },
      input: {}, upstream: [], sectionBrief: "- market-size-and-share: Market size",
      submitToolName: "submit_analysis", extra: "",
    });
    expect(prompt).toContain("Target revenue: R100 000");
    expect(prompt).toContain("current binding constraint is undetermined");
    expect(prompt).not.toContain("Be decisive rather than balanced");
    expect(prompt).not.toContain("PROVIDER_VOICE_SENTINEL");
    expect(prompt).not.toContain("PROVIDER_PROOF_SENTINEL");
    expect(MARKET_SYSTEM).toContain("A revenue target without a stated period is ambiguous");
    expect(MARKET_SYSTEM).toContain("direct working primary-source URL");
    expect(MARKET_SYSTEM).toContain("publisher's publication index");
    expect(MARKET_SYSTEM).toContain("Building plans passed measure approvals");
    expect(MARKET_SYSTEM).toContain("Do not state tax or legal thresholds");
    expect(MARKET_SYSTEM).toContain("current binding constraint is undetermined");
    expect(MARKET_SYSTEM).toContain("Keep separately dated fields separate");
    expect(MARKET_SYSTEM).toContain("Target buyer geography is not a delivery or service boundary");
  });

  it("requires fetched, matched evidence and honest unknowns before persistence", () => {
    const sourced = "Context: supplied. External evidence: none verified. Evidence limit: no external measure used. Unknown: buyer count. Answer: undetermined.";
    expect(validateMarketSections({
      "market-size-and-share": "Context: supplied. External evidence: publisher name. Evidence limit: category activity. Unknown: buyer count. Answer: undetermined.",
      "market-direction": sourced,
    })).toMatch(/Source, Quote and Scope/);
    expect(validateMarketSections({
      "market-size-and-share": sourced,
      "market-direction": "Context: supplied. External evidence: publisher name. Evidence limit: category activity. Unknown: direction. Answer: undetermined.",
    })).toMatch(/Source, Quote and Scope/);
    expect(validateMarketSections({
      "market-size-and-share": sourced,
      "market-direction": sourced,
    })).toBeNull();
    expect(validateMarketSections({
      "market-size-and-share": sourced,
      "market-direction": "Context: supplied. External evidence: none verified. Evidence limit: no external measure used. Unknown: target trend. Answer: Newest release identified: July 2026.",
    })).toMatch(/verified issue date/);
    expect(validateMarketSections({
      "market-size-and-share": sourced,
      "market-direction": "Context: supplied. External evidence: none verified. Evidence limit: no external measure used. Unknown: target trend. Answer: Direction unknown. I am not calling February 2026 the newest issue; recency is unverified.",
    })).toBeNull();
    expect(validateMarketSections({
      "market-size-and-share": "Context: supplied. External evidence: none verified. Evidence limit: no external measure used. Unknown: No public count exists for this buyer segment. Answer: share unknown.",
      "market-direction": sourced,
    })).toMatch(/cannot establish/);
    expect(validateMarketSections({
      "market-size-and-share": "Context: supplied. External evidence: none verified. Unknown: buyer count. Answer: undetermined.",
      "market-direction": sourced,
    })).toMatch(/Evidence limit/);
  });
});
