import { describe, expect, it } from "vitest";
import { campaignDraftProblem, normaliseCampaignDraft } from "./draft.js";

const good = (over: Record<string, unknown> = {}) => ({
  name: "January full-arch diary fill",
  brief:
    "Fill the January consultation diary with full-arch patients. The offer strategy says the written plan assessment is the entry point nobody is using, and the ICP's endgame segment is the one already paying privately.",
  reasoning: "The assessment is on file and unused.",
  ...over,
});

describe("a proposal the planner can work from", () => {
  it("accepts one grounded in what is on file", () => {
    expect(campaignDraftProblem(good())).toBeNull();
  });

  it("names the missing half rather than failing as a whole", () => {
    expect(campaignDraftProblem(good({ name: "" }))).toMatch(/no campaign name/i);
    expect(campaignDraftProblem(good({ brief: "" }))).toMatch(/says nothing about what the campaign is for/i);
  });

  it("rejects an ask too thin to plan from", () => {
    expect(campaignDraftProblem(good({ brief: "Get more leads." }))).toMatch(/too thin/i);
  });

  it("rejects a bracketed placeholder", () => {
    expect(campaignDraftProblem(good({ name: "[season] push" }))).toMatch(/placeholder/i);
  });
});

// The planner is told never to invent a budget and it holds that line. It
// cannot hold it against a brief that already contains one: a figure in the
// ask reads as the operator's instruction, and the plan commits to it.
describe("money the model has no basis for", () => {
  it("rejects an invented budget in the ask", () => {
    for (const figure of ["R50,000", "$20k", "£8 000", "€15 million"]) {
      expect(
        campaignDraftProblem(good({ brief: `${good().brief} Budget is ${figure}.` })),
        figure,
      ).toMatch(/names a budget/i);
    }
  });

  it("does not mistake an ordinary number for money", () => {
    // Counts, ages and dates are legitimate in an ask. "for 50 people" nearly
    // was: \bR matches the r in "for" unless the boundary is right.
    for (const line of [
      "Aimed at over-55s, 40 consultations.",
      "Book 40 consultations in January.",
      "Run it for 50 people on the list.",
      "Four practices, two weeks.",
    ]) {
      expect(campaignDraftProblem(good({ brief: `${good().brief} ${line}` })), line).toBeNull();
    }
  });
});

describe("normaliseCampaignDraft", () => {
  it("returns only the two fields the form takes", () => {
    const out = normaliseCampaignDraft({ ...good(), budget: 50000, starts_on: "2027-01-05" });
    expect(Object.keys(out).sort()).toEqual(["brief", "name"]);
  });

  it("drops the reasoning, which is for the operator and not the record", () => {
    const out = normaliseCampaignDraft(good());
    expect(JSON.stringify(out)).not.toContain("on file and unused");
  });

  it("trims, and treats anything that is not a string as absent", () => {
    expect(normaliseCampaignDraft({ name: "  x  ", brief: 42 })).toEqual({ name: "x", brief: "" });
  });
});
