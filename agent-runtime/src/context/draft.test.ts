import { describe, expect, it } from "vitest";
import { reviewContextDraft, normaliseContextDraft, CONTEXT_FIELDS } from "./draft.js";

const long = (s: string) => s.padEnd(80, ".");

const good = (over: Record<string, unknown> = {}) => ({
  business_overview: long("Implant and veneer dentistry in Durban, two chairs, one dentist who plans every case"),
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

describe("a clean draft", () => {
  it("passes everything through untouched", () => {
    const review = reviewContextDraft(good());
    expect(review.problem).toBeNull();
    expect(review.dropped).toEqual([]);
    expect(review.draft.business_overview).toContain("Implant and veneer dentistry");
  });

  it("leaves optional fields empty without complaint", () => {
    const review = reviewContextDraft(good({ brand_voice: "", current_marketing: "" }));
    expect(review.problem).toBeNull();
    expect(review.dropped).toEqual([]);
  });
});

// Two production runs were thrown away over a single field — one for a length
// cap set below real data, one for a hedged competitors line — both after all
// the searching was done. Eight good fields and one empty one the operator
// fills is a far better outcome than nothing.
describe("one bad field does not bin the run", () => {
  it("blanks the hedged field and keeps the rest", () => {
    const review = reviewContextDraft(
      good({ brand_voice: "They appear to be positioned as the premium option locally." }),
    );
    expect(review.problem).toBeNull();
    expect(review.draft.brand_voice).toBe("");
    expect(review.draft.business_overview).toContain("Implant and veneer dentistry");
    expect(review.draft.main_offer).toContain("Full-arch");
  });

  it("names the field and says why, so nobody is left guessing", () => {
    const review = reviewContextDraft(good({ brand_voice: "Presumably they are informal." }));
    expect(review.dropped).toHaveLength(1);
    expect(review.dropped[0]!.field).toBe("brand_voice");
    expect(review.dropped[0]!.reason).toMatch(/hedging rather than reporting/i);
  });

  it("drops a placeholder the same way", () => {
    const review = reviewContextDraft(good({ current_marketing: "Active on [platform]." }));
    expect(review.draft.current_marketing).toBe("");
    expect(review.dropped[0]!.reason).toMatch(/placeholder/i);
    expect(review.problem).toBeNull();
  });

  it("drops runaway output and says how long it was", () => {
    const review = reviewContextDraft(good({ brand_voice: "x".repeat(12001) }));
    expect(review.draft.brand_voice).toBe("");
    expect(review.dropped[0]!.reason).toMatch(/12001 characters/);
    expect(review.problem).toBeNull();
  });

  it("accepts an overview longer than the largest real record", () => {
    // AA's own business_overview is 2954 characters. A cap set just above
    // real data forbids improving it, and costs a searching run to learn.
    const review = reviewContextDraft(good({ business_overview: "x".repeat(5019) }));
    expect(review.dropped).toEqual([]);
    expect(review.draft.business_overview).toHaveLength(5019);
  });
});

describe("when nothing usable survives", () => {
  it("refuses outright rather than showing an empty form", () => {
    const review = reviewContextDraft({
      business_overview: "Presumably dentistry.",
      ideal_customer: "They appear to be adults.",
      main_offer: "[the offer]",
      competitors: "Probably several.",
    });
    expect(review.problem).toMatch(/none of the four fields every agent reads survived/i);
  });

  it("still refuses when the four are simply absent", () => {
    expect(reviewContextDraft({}).problem).toMatch(/nothing usable/i);
  });
});

// Revenue feeds the money model and the economics engine. Being roughly right
// is worse than being empty, because empty gets asked about.
describe("revenue is never researched", () => {
  it("drops both figures even when the model returns them", () => {
    const out = normaliseContextDraft({ ...good(), current_revenue: "R4.2m", target_revenue: "R10m" });
    expect(out.current_revenue).toBe("");
    expect(out.target_revenue).toBe("");
    expect(JSON.stringify(out)).not.toContain("4.2m");
  });

  it("returns exactly the form's fields and nothing else", () => {
    const out = normaliseContextDraft({ ...good(), made_up: true });
    expect(Object.keys(out).sort()).toEqual([...CONTEXT_FIELDS].sort());
  });

  it("does not carry the sources note into a saved field", () => {
    expect(JSON.stringify(normaliseContextDraft(good()))).not.toContain("Read their homepage");
  });
});


// Competitor POSITIONING is an inference by nature: you read a rival's site
// and conclude they lead on price. This is the one field the guard fired on
// in production, and it fired on a sentence doing its job.
describe("hedging about a competitor's positioning is honest", () => {
  it("keeps a hedged reading of how a rival is positioned", () => {
    const review = reviewContextDraft(
      good({
        competitors: "Umhlanga Dental Studio, who appear to be positioned as the premium option locally, and doing nothing.",
      }),
    );
    expect(review.dropped).toEqual([]);
    expect(review.draft.competitors).toContain("Umhlanga Dental Studio");
  });

  it("does not extend the exemption to any other field", () => {
    // Business overview hedged is still a guess dressed as a fact.
    const review = reviewContextDraft(
      good({ business_overview: "They appear to be a dental practice serving the north coast." }),
    );
    expect(review.dropped.map((d) => d.field)).toEqual(["business_overview"]);
  });

  it("still drops a placeholder in competitors", () => {
    // The exemption is from hedging only. "[competitor]" is nobody.
    const review = reviewContextDraft(good({ competitors: "The main one is [competitor name]." }));
    expect(review.dropped[0]!.field).toBe("competitors");
    expect(review.dropped[0]!.reason).toMatch(/placeholder/i);
  });

  it("still drops runaway output in competitors", () => {
    const review = reviewContextDraft(good({ competitors: "x".repeat(12001) }));
    expect(review.dropped[0]!.reason).toMatch(/12001 characters/);
  });
});
