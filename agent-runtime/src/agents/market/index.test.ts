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
    expect(prompt).toContain("current binding constraint undetermined");
    expect(prompt).not.toContain("Be decisive rather than balanced");
    expect(prompt).not.toContain("PROVIDER_VOICE_SENTINEL");
    expect(prompt).not.toContain("PROVIDER_PROOF_SENTINEL");
    expect(MARKET_SYSTEM).toContain("EXTERNAL SOURCE CONTRACT");
    expect(MARKET_SYSTEM).toContain("BUSINESS CONTEXT CONTRACT");
    expect(MARKET_SYSTEM).toContain("copy one exact, self-contained source sentence");
    expect(MARKET_SYSTEM).toContain("The context update does not date an embedded founder diagnostic");
    expect(MARKET_SYSTEM).toContain("current binding constraint is undetermined");
    expect(MARKET_SYSTEM).toContain("keep one-off revenue separate from monthly recurring revenue");
    expect(prompt).toContain("Use no more than one external indicator in market-size-and-share");
    expect(prompt).toContain("label one-off revenue separately from recurring revenue");
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
      "market-size-and-share": "Context: supplied. External evidence: none verified. Evidence limit: no external measure used. Unknown: No reachable-buyer denominator exists for this market. Answer: share unknown.",
      "market-direction": sourced,
    })).toMatch(/cannot establish/);
    expect(validateMarketSections({
      "market-size-and-share": "Context: supplied. External evidence: none verified. Evidence limit: no external measure used. Unknown: not found in this pass, not proof that no public source exists. Answer: share unknown.",
      "market-direction": sourced,
    })).toBeNull();
    expect(validateMarketSections({
      "market-size-and-share": sourced,
      "market-direction": "Context: supplied. External evidence: none verified. Evidence limit: no external measure used. Unknown: absence here does not mean no public source exists. Answer: direction unknown.",
    })).toBeNull();
    expect(validateMarketSections({
      "market-size-and-share": sourced,
      "market-direction": "Context: supplied. External evidence: none verified. Evidence limit: no external measure used. Unknown: later issues exist. Answer: direction unknown.",
    })).toMatch(/cannot infer later publication/);
    expect(validateMarketSections({
      "market-size-and-share": sourced,
      "market-direction": "Context: supplied. External evidence: none verified. Evidence limit: no external measure used. Unknown: I do not claim later issues exist. Answer: direction unknown.",
    })).toBeNull();
    expect(validateMarketSections({
      "market-size-and-share": sourced,
      "market-direction": sourced,
      "constraint-diagnosis": "Context: date of that diagnostic is absent; no pipeline was noted. External evidence: none verified. Evidence limit: no external measure used. Unknown: current count. Answer: the dated source showed no recorded pipeline.",
    })).toMatch(/attaches an undated pipeline note/);
    expect(validateMarketSections({
      "market-size-and-share": sourced,
      "market-direction": sourced,
      "commercial-structure": sourced.replace("Answer: undetermined", "Answer: media cost sits outside AA's invoice."),
    })).toMatch(/unsupported call, invoice or media-cost mechanics/);
    expect(validateMarketSections({
      "market-size-and-share": sourced,
      "market-direction": sourced.replace("Answer: undetermined", "Answer: much of the target work needs no building plan."),
    })).toMatch(/unverified planning-permit applicability/);
    expect(validateMarketSections({
      "market-size-and-share": sourced,
      "market-direction": sourced,
      "commercial-structure": sourced.replace("Answer: undetermined", "Answer: media pass-through is the model."),
    })).toMatch(/calls client-paid media a pass-through/);
    expect(validateMarketSections({
      "market-size-and-share": sourced,
      "market-direction": sourced,
      "commercial-structure": sourced.replace("Answer: undetermined", "Answer: the marketplace charges per contact rather than per month."),
    })).toMatch(/absence of monthly competitor fees/);
    expect(validateMarketSections({
      "market-size-and-share": sourced,
      "market-direction": sourced,
      "commercial-structure": sourced.replace("Answer: undetermined", "Answer: measure time to first monthly invoice."),
    })).toMatch(/assumes a monthly invoice/);
    expect(validateMarketSections({
      "market-size-and-share": "Context: supplied. External evidence: none verified. Unknown: buyer count. Answer: undetermined.",
      "market-direction": sourced,
    })).toMatch(/Evidence limit/);
  });

  it("checks recurring-revenue arithmetic against a client's one-off offer", () => {
    const context = {
      business_overview: null, ideal_customer: null,
      main_offer: "Proof Sprint, R7,500 once-off: one turn. Proof Brand, R32,500 per month: the monthly loop.",
      competitors: null, brand_voice: null, proof_testimonials: null,
      current_marketing: null, sales_process: null, current_revenue: null, target_revenue: null,
    };
    const direction = "Context: supplied. External evidence: none verified. Evidence limit: no external measure used. Unknown: direction. Answer: direction unknown.";
    const size = "Context: Proof Sprint is R7,500 once-off. External evidence: none verified. Evidence limit: no external measure used. Unknown: market share. Answer: Share unknown. Conditional monthly recurring revenue: 14 × Proof Sprint = R105,000.";
    expect(validateMarketSections({ "market-size-and-share": size, "market-direction": direction }, [], context))
      .toMatch(/one-off offer as monthly recurring revenue/);
    expect(validateMarketSections({
      "market-size-and-share": size.replace("14 × Proof Sprint = R105,000", "Proof Sprint is once-off and excluded from MRR"),
      "market-direction": direction,
    }, [], context)).toBeNull();
    expect(validateMarketSections({
      "market-size-and-share": size.replace("Share unknown.", "Share unknown; once-off sales need separate accounting."),
      "market-direction": direction,
    }, [], context)).toMatch(/one-off offer as monthly recurring revenue/);
  });
});
