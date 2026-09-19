import { describe, expect, it } from "vitest";
import { contextDraftProblem, normaliseContextDraft, CONTEXT_FIELDS } from "./draft.js";

const long = (s: string) => s.padEnd(80, " ").trim().padEnd(80, ".");

const good = (over: Record<string, unknown> = {}) => ({
  business_overview: long("Implant and veneer dentistry in Durban, two chairs, one dentist who plans and places every case"),
  ideal_customer: long("Somebody whose bridge has failed twice and who has stopped eating on one side"),
  main_offer: long("Full-arch implant work, priced after imaging and a written plan assessment"),
  competitors: long("Named: Umhlanga Dental Studio, and doing nothing, which is the real alternative"),
  brand_voice: "Plain, unhurried, refuses to oversell.",
  proof_testimonials: "",
  current_marketing: "Instagram, roughly weekly.",
  sales_process: "Phone, then a paid assessment.",
  sources: "Read their homepage and treatments page.",
  ...over,
});

describe("a draft worth putting in front of the operator", () => {
  it("accepts one that is specific and sourced", () => {
    expect(contextDraftProblem(good())).toBeNull();
  });

  it("accepts empty optional fields, because empty gets asked about", () => {
    expect(
      contextDraftProblem(good({ brand_voice: "", current_marketing: "", sales_process: "" })),
    ).toBeNull();
  });
});

describe("the four every agent reads", () => {
  it("refuses to leave one empty", () => {
    for (const field of ["business_overview", "ideal_customer", "main_offer", "competitors"]) {
      expect(contextDraftProblem(good({ [field]: "" })), field).toMatch(/says nothing about/i);
    }
  });

  it("refuses one too thin to act on", () => {
    // "Various local providers" is not competitor research.
    expect(contextDraftProblem(good({ competitors: "Various local providers." }))).toMatch(/too thin/i);
  });
});

// A model researching a real company reads a lot of other companies' pages.
describe("guessing, politely", () => {
  it("rejects hedged prose, which reads as fact once an agent quotes it", () => {
    for (const hedge of [
      "The practice likely serves the north coast.",
      "They appear to be positioned as a premium provider.",
      "Presumably they take referrals.",
      "We can assume the buyer is price-sensitive.",
    ]) {
      expect(contextDraftProblem(good({ brand_voice: hedge })), hedge).toMatch(/hedging rather than reporting/i);
    }
  });

  it("rejects a placeholder", () => {
    expect(contextDraftProblem(good({ current_marketing: "Active on [platform]." }))).toMatch(/placeholder/i);
  });
});

// Revenue feeds the money model and the economics engine. Being roughly right
// is worse than being empty, because empty gets asked about.
describe("revenue is never researched", () => {
  it("drops both figures even when the model returns them", () => {
    const out = normaliseContextDraft({
      ...good(),
      current_revenue: "R4.2m",
      target_revenue: "R10m by 2028",
    });
    expect(out.current_revenue).toBe("");
    expect(out.target_revenue).toBe("");
    expect(JSON.stringify(out)).not.toContain("4.2m");
    expect(JSON.stringify(out)).not.toContain("R10m");
  });

  it("keeps every other field it was given", () => {
    const out = normaliseContextDraft(good());
    expect(out.business_overview).toContain("Implant and veneer dentistry");
    expect(out.competitors).toContain("Umhlanga Dental Studio");
  });
});

describe("normaliseContextDraft", () => {
  it("returns exactly the form's fields and nothing else", () => {
    const out = normaliseContextDraft({ ...good(), sources: "homepage", made_up: true });
    expect(Object.keys(out).sort()).toEqual([...CONTEXT_FIELDS].sort());
  });

  it("does not carry the sources note into a saved field", () => {
    // Sources are for the operator to check, not for an agent to read back.
    const out = normaliseContextDraft(good());
    expect(JSON.stringify(out)).not.toContain("Read their homepage");
  });
});
