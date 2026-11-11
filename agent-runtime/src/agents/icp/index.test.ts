import { describe, expect, it } from "vitest";
import { buildIcpPrompt, ICP_SYSTEM, validateIcpSections } from "./index.js";

const base = {
  templates: [],
  context: null,
  upstream: [],
  sectionBrief: "- question-universe: Buyer questions",
  submitToolName: "submit_analysis",
  extra: "",
};

describe("ICP customer-language provenance", () => {
  it("treats the planned buyer and behavior as hypotheses, not observed customer facts", () => {
    const prompt = buildIcpPrompt({
      ...base,
      input: {},
    });

    expect(prompt).toContain("intended buyer hypothesis");
    expect(prompt).toContain("not measured buyer behavior");
    expect(prompt).toContain("25–60 words");
    expect(prompt).toContain('"Awareness:", "Comparison:", and "Decision:"');
    expect(prompt).toContain('"Source (field name and operator hypothesis)", "Unknown", and "Validate"');
    expect(ICP_SYSTEM).toContain("Do not turn a target-segment assumption into an observed trait");
    expect(ICP_SYSTEM).toContain("candidate questions to validate");
    expect(ICP_SYSTEM).toContain("does not establish that clients, references, testimonials");
    expect(ICP_SYSTEM).toContain("Revenue does not establish deal, lead or sales-cycle status");
    expect(ICP_SYSTEM).toContain("no verified quote or transcript was supplied for this analysis");
    expect(ICP_SYSTEM).toContain("A trade type and city do not prove where the buyer works");
    expect(ICP_SYSTEM).toContain("not a single-person buying unit");
    expect(ICP_SYSTEM).toContain("Convert possible implications into Validate questions");
    expect(ICP_SYSTEM).toContain("Do not prescribe a new buyer split");
    expect(ICP_SYSTEM).toContain("A named competitor is not evidence that the target buyer uses");
    expect(ICP_SYSTEM).toContain("a missing outcome figure does not establish whether a client has run the loop");
  });

  it("treats the legacy customer-language field as notes, not a verbatim quote", () => {
    const prompt = buildIcpPrompt({
      ...base,
      input: { voice_of_customer: "Several callers seemed worried about delays." },
    });

    expect(prompt).toContain("CUSTOMER LANGUAGE NOTES");
    expect(prompt).toContain("never quote or attribute their wording as exact customer speech");
    expect(prompt).not.toContain("VERIFIED VERBATIM CUSTOMER QUOTES\n");
  });

  it("keeps provider revenue, marketing and sales process out of buyer evidence", () => {
    const prompt = buildIcpPrompt({
      ...base,
      context: {
        business_overview: "Makes a useful service.",
        ideal_customer: "Owner operator.",
        main_offer: "Monthly service.",
        competitors: null,
        brand_voice: null,
        proof_testimonials: "PROVIDER_PROOF_SENTINEL",
        current_marketing: "FACEBOOK_PROVIDER_PLAN_SENTINEL",
        sales_process: "PROVIDER_SALES_PROCESS_SENTINEL",
        current_revenue: "R0_PROVIDER_REVENUE_SENTINEL",
        target_revenue: "PROVIDER_TARGET_SENTINEL",
      },
      input: {},
    });
    expect(prompt).toContain("Owner operator.");
    expect(prompt).toContain("Monthly service.");
    expect(prompt).not.toContain("FACEBOOK_PROVIDER_PLAN_SENTINEL");
    expect(prompt).not.toContain("PROVIDER_SALES_PROCESS_SENTINEL");
    expect(prompt).not.toContain("R0_PROVIDER_REVENUE_SENTINEL");
    expect(prompt).not.toContain("PROVIDER_TARGET_SENTINEL");
    expect(prompt).not.toContain("PROVIDER_PROOF_SENTINEL");
  });

  it("blocks an unstaged or empty buyer question universe", () => {
    expect(validateIcpSections({ "question-universe": "What will it cost?" }))
      .toMatch(/awareness/i);
    expect(validateIcpSections({ "question-universe":
      "Awareness: What is this? Comparison: How is it different? Decision: We should buy." }))
      .toMatch(/decision/i);
    expect(validateIcpSections({ "question-universe":
      "Awareness: What is this? Comparison: How is it different? Decision: Who pays for ads?" }))
      .toBeNull();
  });

  it("keeps explicitly verified quotes in their own attributed section", () => {
    const prompt = buildIcpPrompt({
      ...base,
      input: {
        voice_of_customer: "Caller summary: scheduling was confusing.",
        verified_customer_quotes: "I could not find a time that worked.",
        verified_quote_source: "Call transcript",
        verified_quote_date: "2026-10-01",
      },
    });

    expect(prompt).toContain("CUSTOMER LANGUAGE NOTES");
    expect(prompt).toContain("VERIFIED VERBATIM CUSTOMER QUOTES");
    expect(prompt).toContain("Source: Call transcript");
    expect(prompt).toContain("Date: 2026-10-01");
    expect(prompt).toContain("Exact words:\nI could not find a time that worked.");
    expect(prompt.indexOf("CUSTOMER LANGUAGE NOTES")).toBeLessThan(
      prompt.indexOf("VERIFIED VERBATIM CUSTOMER QUOTES"),
    );
  });

  it("downgrades a quote without a source to unquotable notes", () => {
    const prompt = buildIcpPrompt({
      ...base,
      input: { verified_customer_quotes: "This might be an exact quote." },
    });

    expect(prompt).toContain("CUSTOMER LANGUAGE NOTES");
    expect(prompt).not.toContain("VERIFIED VERBATIM CUSTOMER QUOTES\n");
  });

  it("downgrades a quote without a date to unquotable notes", () => {
    const prompt = buildIcpPrompt({
      ...base,
      input: { verified_customer_quotes: "This might be an exact quote.", verified_quote_source: "Call transcript" },
    });

    expect(prompt).toContain("CUSTOMER LANGUAGE NOTES");
    expect(prompt).not.toContain("VERIFIED VERBATIM CUSTOMER QUOTES\n");
  });
});
