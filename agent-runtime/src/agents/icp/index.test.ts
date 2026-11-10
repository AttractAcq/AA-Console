import { describe, expect, it } from "vitest";
import { buildIcpPrompt } from "./index.js";

const base = {
  templates: [],
  context: null,
  upstream: [],
  sectionBrief: "- question-universe: Buyer questions",
  submitToolName: "submit_analysis",
  extra: "",
};

describe("ICP customer-language provenance", () => {
  it("treats the legacy customer-language field as notes, not a verbatim quote", () => {
    const prompt = buildIcpPrompt({
      ...base,
      input: { voice_of_customer: "Several callers seemed worried about delays." },
    });

    expect(prompt).toContain("CUSTOMER LANGUAGE NOTES");
    expect(prompt).toContain("never quote or attribute their wording as exact customer speech");
    expect(prompt).not.toContain("VERIFIED VERBATIM CUSTOMER QUOTES\n");
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
