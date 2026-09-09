import { describe, expect, it } from "vitest";
import {
  asAmount,
  asCount,
  asDate,
  normaliseChannels,
  planProblem,
  planSummary,
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
