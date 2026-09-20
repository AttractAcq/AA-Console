import { templateFor } from "../../campaigns/templates.js";
import { describe, expect, it } from "vitest";
import { SUBMIT_TOOL } from "./index.js";
import { unsupportedStrictKeywords } from "../../tools/schema.js";
import {
  asAmount,
  asCount,
  asDate,
  campaignIdeas,
  normaliseChannels,
  planProblem,
  planSummary,
  resolveNeeds,
  MAX_CONTENT,
  type CampaignPlan,
} from "./plan.js";

const good = (over: Partial<CampaignPlan> = {}): CampaignPlan => ({
  objective: "Book 40 full-arch consultations in January",
  audience: "Over-55s living with a failing plate",
  offer_summary: "Free consultation and a written treatment plan",
  core_message: "Chewing is not a cosmetic problem",
  channels: ["instagram", "facebook"],
  budget: 20000,
  starts_on: "2027-01-05",
  ends_on: "2027-01-31",
  kpi_metric: "consultations booked",
  kpi_target: 40,
  content_count: 6,
  needs_landing_page: true,
  needs_sales_agent: true,
  ...over,
});

describe("planProblem", () => {
  it("accepts a plan that can actually be executed", () => {
    expect(planProblem(good())).toBeNull();
  });

  it("rejects a plan with no objective, audience or message", () => {
    expect(planProblem(good({ objective: "" }))).toMatch(/no objective/i);
    expect(planProblem(good({ audience: "" }))).toMatch(/nobody to aim at/i);
    expect(planProblem(good({ core_message: "" }))).toMatch(/no message/i);
  });

  it("rejects a plan with nowhere to run", () => {
    expect(planProblem(good({ channels: [] }))).toMatch(/no channel/i);
  });

  it("rejects a plan nobody can score", () => {
    // A campaign with no KPI is a campaign nobody can stop.
    expect(planProblem(good({ kpi_metric: "" }))).toMatch(/no KPI/i);
  });

  it("rejects a plan that ends before it starts", () => {
    expect(planProblem(good({ starts_on: "2027-02-01", ends_on: "2027-01-01" }))).toMatch(
      /ending before it starts/i,
    );
  });

  it("rejects a plan that asks for nothing to be built", () => {
    // This is the one that matters: a campaign with no requirements would
    // report itself ready the moment it was planned.
    const problem = planProblem(
      good({ content_count: 0, needs_landing_page: false, needs_sales_agent: false }),
    );
    expect(problem).toMatch(/asks for nothing to be built/i);
  });

  it("accepts a plan that asks for only one thing", () => {
    expect(
      planProblem(good({ content_count: 0, needs_landing_page: true, needs_sales_agent: false })),
    ).toBeNull();
    expect(
      planProblem(good({ content_count: 3, needs_landing_page: false, needs_sales_agent: false })),
    ).toBeNull();
  });

  it("accepts a plan with no dates at all", () => {
    expect(planProblem(good({ starts_on: null, ends_on: null }))).toBeNull();
  });
});

describe("asCount", () => {
  it("keeps a whole count", () => {
    expect(asCount(6)).toBe(6);
    expect(asCount(0)).toBe(0);
  });
  it("caps a runaway request, since every piece is real work for a person", () => {
    expect(asCount(9999)).toBe(MAX_CONTENT);
  });
  it("floors a fraction and refuses a negative", () => {
    expect(asCount(3.9)).toBe(3);
    expect(asCount(-4)).toBe(0);
  });
  it("returns 0 for anything that is not a number", () => {
    expect(asCount("lots")).toBe(0);
    expect(asCount(undefined)).toBe(0);
    expect(asCount(null)).toBe(0);
  });
});

describe("asAmount", () => {
  it("distinguishes a real zero from an unknown", () => {
    // Zero budget and "no basis for a number" are different answers.
    expect(asAmount(0)).toBe(0);
    expect(asAmount(undefined)).toBeNull();
    expect(asAmount("about twenty grand")).toBeNull();
  });
  it("refuses a negative amount", () => {
    expect(asAmount(-100)).toBeNull();
  });
});

describe("asDate", () => {
  it("accepts an ISO date", () => {
    expect(asDate("2027-01-05")).toBe("2027-01-05");
  });
  it("rejects anything Postgres would choke on", () => {
    // A malformed date would fail the whole write and lose a plan already paid for.
    expect(asDate("5 January")).toBeNull();
    expect(asDate("2027-13-45")).toBeNull();
    expect(asDate("")).toBeNull();
    expect(asDate(undefined)).toBeNull();
  });
});

describe("normaliseChannels", () => {
  it("lowercases and de-duplicates", () => {
    expect(normaliseChannels(["Instagram", "instagram", "FACEBOOK"])).toEqual([
      "instagram",
      "facebook",
    ]);
  });
  it("drops blanks and non-strings", () => {
    expect(normaliseChannels(["  ", null, 7, "tiktok"])).toEqual(["tiktok"]);
  });
  it("returns empty for anything that is not a list", () => {
    expect(normaliseChannels("instagram")).toEqual([]);
  });
});

describe("planSummary", () => {
  it("says what has to be built, so the plan is legible at a glance", () => {
    const summary = planSummary(good());
    expect(summary).toContain("6 pieces of content");
    expect(summary).toContain("a landing page");
    expect(summary).toContain("a sales agent");
    expect(summary).toContain("consultations booked");
  });
});

describe("campaignIdeas", () => {
  const idea = (title: string) => ({
    title,
    body: "Use the festive diary deadline to make the assessment feel urgent.",
    media_type: "text",
    channel: "whatsapp",
    strategic_reason: "It turns a vague enquiry into a booked written plan assessment.",
  });

  it("accepts exactly the promised number of complete ideas", () => {
    expect(campaignIdeas([idea("Photo triage"), idea("Written total")], 2)).toEqual([
      idea("Photo triage"),
      idea("Written total"),
    ]);
  });

  it("rejects missing, extra or duplicate ideas", () => {
    expect(() => campaignIdeas([idea("Only one")], 2)).toThrow(/exactly 2/i);
    expect(() => campaignIdeas([idea("Same"), idea("same")], 2)).toThrow(/distinct title/i);
  });

  it("rejects incomplete ideas and unsupported media types", () => {
    expect(() => campaignIdeas([{ ...idea("No body"), body: "" }], 1)).toThrow(/angle/i);
    expect(() => campaignIdeas([{ ...idea("Carousel"), media_type: "carousel" }], 1)).toThrow(/media type/i);
  });

  it("allows a campaign that asks for no content to save an empty batch", () => {
    expect(campaignIdeas([], 0)).toEqual([]);
  });
});


// The Campaign Planner was down in production with
//   Anthropic 400: tools.0.custom: For 'array' type, property 'maxItems' is
//   not supported
// because the ideas array carried maxItems and its title carried maxLength.
// Neither is accepted on a strict tool, and every run failed.
describe("the submit tool schema", () => {
  it("uses only what a strict tool may contain", () => {
    expect(unsupportedStrictKeywords(SUBMIT_TOOL.inputSchema)).toEqual([]);
  });

  it("still asks for the ideas the campaign needs", () => {
    // The fix must not have been to delete the field.
    const props = SUBMIT_TOOL.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.ideas?.type).toBe("array");
    expect(SUBMIT_TOOL.inputSchema.required).toContain("ideas");
  });

  it("tells the model the limits that code will enforce anyway", () => {
    // A constraint removed from the schema still has to be stated somewhere, or
    // the model is guessing and every run pays for a rejected batch.
    const props = SUBMIT_TOOL.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(String(props.ideas?.description)).toContain(String(MAX_CONTENT));
    const items = props.ideas?.items as Record<string, Record<string, Record<string, unknown>>>;
    expect(String(items.properties?.title?.description)).toMatch(/300/);
  });

  it("enforces in code what the schema can no longer say", () => {
    // The real guarantee: a batch longer than promised is refused outright.
    expect(() => campaignIdeas(new Array(4).fill(idea()), 3)).toThrow(/exactly 3/i);
    expect(() => campaignIdeas([idea({ title: "x".repeat(301) })], 1)).toThrow(/distinct title/i);
  });
});

function idea(over: Record<string, unknown> = {}) {
  return {
    title: "A distinct angle",
    body: "The concrete angle and the call to action.",
    media_type: "text",
    channel: "instagram",
    strategic_reason: "It answers the buyer's first objection.",
    ...over,
  };
}

describe("resolveNeeds", () => {
  const model = { needs_landing_page: true, needs_sales_agent: true };

  it("lets the model decide when there is no template", () => {
    expect(resolveNeeds(null, model)).toEqual({
      needs_landing_page: true,
      needs_sales_agent: true,
    });
    expect(resolveNeeds(null, { needs_landing_page: false, needs_sales_agent: false })).toEqual({
      needs_landing_page: false,
      needs_sales_agent: false,
    });
  });

  it("treats anything but true from the model as false", () => {
    expect(resolveNeeds(null, { needs_landing_page: "yes", needs_sales_agent: 1 })).toEqual({
      needs_landing_page: false,
      needs_sales_agent: false,
    });
  });

  it("overrules the model where a template has already decided", () => {
    // P2 uses an instant form and needs neither, whatever the model said.
    expect(resolveNeeds(templateFor("P2"), model)).toEqual({
      needs_landing_page: false,
      needs_sales_agent: false,
    });
  });

  it("requires a sales agent for the template that opens a DM", () => {
    expect(resolveNeeds(templateFor("P3"), { needs_landing_page: true, needs_sales_agent: false })).toEqual({
      needs_landing_page: false,
      needs_sales_agent: true,
    });
  });

  it("requires a landing page where the ad points at one", () => {
    expect(resolveNeeds(templateFor("R1"), { needs_landing_page: false, needs_sales_agent: false })).toEqual({
      needs_landing_page: true,
      needs_sales_agent: false,
    });
  });
});
