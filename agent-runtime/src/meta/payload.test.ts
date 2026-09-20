import { describe, expect, it } from "vitest";
import { templateFor } from "../campaigns/templates.js";
import {
  PAUSED,
  adPayload,
  adSetPayload,
  campaignPayload,
  minorUnits,
  promotedObject,
  specialAdCategories,
  targetingProblem,
  type Targeting,
} from "./payload.js";

const geo: Targeting = { geo_locations: { countries: ["ZA"] } };

const adSetArgs = {
  name: "P2 · Cape Town · leads",
  campaignId: "23851",
  template: templateFor("P2")!,
  optimisationGoal: "LEAD_GENERATION",
  dailyBudget: 250,
  currency: "ZAR",
  targeting: geo,
  purpose: "client",
  ids: { pageId: "1122" },
};

describe("budgets reach Meta in the units it bills in", () => {
  it("sends a two-decimal currency in minor units", () => {
    expect(minorUnits(250, "ZAR")).toBe(25000);
    expect(minorUnits(50.1, "ZAR")).toBe(5010);
    expect(minorUnits(0.01, "GBP")).toBe(1);
  });

  it("sends a zero-decimal currency as written", () => {
    expect(minorUnits(5000, "JPY")).toBe(5000);
    expect(minorUnits(5000, "KRW")).toBe(5000);
  });

  it("refuses a fraction of a minor unit rather than rounding it", () => {
    expect(() => minorUnits(50.005, "ZAR")).toThrow(/finer than one minor unit/);
    expect(() => minorUnits(100.5, "JPY")).toThrow(/no minor unit/);
  });

  it("refuses an amount that is not a positive number", () => {
    expect(() => minorUnits(0, "ZAR")).toThrow(/positive amount/);
    expect(() => minorUnits(-5, "ZAR")).toThrow(/positive amount/);
    expect(() => minorUnits(Number.NaN, "ZAR")).toThrow(/positive amount/);
  });

  it("refuses something that is not a currency code", () => {
    expect(() => minorUnits(10, "rand")).toThrow(/not a currency code/);
    expect(() => minorUnits(10, "")).toThrow(/not a currency code/);
  });

  it("is case and space insensitive about the code itself", () => {
    expect(minorUnits(10, " zar ")).toBe(1000);
    expect(minorUnits(10, "jpy")).toBe(10);
  });
});

describe("special ad categories", () => {
  it("declares employment on a recruitment ad", () => {
    expect(specialAdCategories("recruitment")).toEqual(["EMPLOYMENT"]);
  });

  it("declares nothing on ordinary client work", () => {
    expect(specialAdCategories("client")).toEqual([]);
  });

  it("refuses age or gender targeting once a category is declared", () => {
    const withAge: Targeting = { ...geo, age_min: 25 };
    expect(targetingProblem(withAge, ["EMPLOYMENT"])).toContain("cannot be targeted by age");
    const withGender: Targeting = { ...geo, genders: [1] };
    expect(targetingProblem(withGender, ["EMPLOYMENT"])).toContain("gender");
    expect(targetingProblem({ ...geo, age_max: 40 }, ["EMPLOYMENT"])).toContain("age");
  });

  it("allows age and gender where no category applies", () => {
    expect(targetingProblem({ ...geo, age_min: 25, genders: [1] }, [])).toBeNull();
  });

  it("refuses an ad set with nowhere to run", () => {
    expect(targetingProblem({ geo_locations: {} }, [])).toContain("geo_locations is empty");
  });
});

describe("promoted_object", () => {
  it("attaches the page to the goals that run from one", () => {
    for (const goal of ["LEAD_GENERATION", "CONVERSATIONS", "PROFILE_VISIT"]) {
      expect(promotedObject(goal, { pageId: "1122" })).toEqual({ value: { page_id: "1122" } });
      expect(promotedObject(goal, {})).toEqual({ problem: expect.stringContaining("Facebook page") });
    }
  });

  it("attaches the pixel and the event a conversion campaign counts", () => {
    expect(promotedObject("OFFSITE_CONVERSIONS", { pixelId: "99", conversionEvent: "Lead" })).toEqual({
      value: { pixel_id: "99", custom_event_type: "Lead" },
    });
  });

  it("refuses a conversion goal missing its pixel or its event", () => {
    expect(promotedObject("OFFSITE_CONVERSIONS", { conversionEvent: "Lead" })).toEqual({
      problem: expect.stringContaining("pixel"),
    });
    expect(promotedObject("OFFSITE_CONVERSIONS", { pixelId: "99" })).toEqual({
      problem: expect.stringContaining("event it counts"),
    });
  });

  it("attaches nothing to the goals that need nothing", () => {
    expect(promotedObject("THRUPLAY", {})).toEqual({ value: null });
    expect(promotedObject("POST_ENGAGEMENT", {})).toEqual({ value: null });
  });

  it("refuses a goal it does not build for", () => {
    expect(promotedObject("REACH", { pageId: "1" })).toEqual({
      problem: expect.stringContaining("not an optimisation goal"),
    });
  });
});

describe("the objects sent to Meta", () => {
  it("creates a campaign paused", () => {
    const payload = campaignPayload({ name: "P2 leads", objective: "OUTCOME_LEADS", purpose: "client" });
    expect(payload.status).toBe(PAUSED);
    expect(payload).toEqual({
      name: "P2 leads",
      objective: "OUTCOME_LEADS",
      status: "PAUSED",
      special_ad_categories: [],
      buying_type: "AUCTION",
    });
  });

  it("declares employment on a recruitment campaign", () => {
    const payload = campaignPayload({ name: "Editor", objective: "OUTCOME_LEADS", purpose: "recruitment" });
    expect(payload.special_ad_categories).toEqual(["EMPLOYMENT"]);
  });

  it("creates an ad set paused, with the budget converted", () => {
    const payload = adSetPayload(adSetArgs);
    expect(payload.status).toBe(PAUSED);
    expect(payload.daily_budget).toBe(25000);
    expect(payload.optimization_goal).toBe("LEAD_GENERATION");
    expect(payload.promoted_object).toEqual({ page_id: "1122" });
    expect(payload.billing_event).toBe("IMPRESSIONS");
  });

  it("leaves out the dates and the promoted object when there are none", () => {
    const payload = adSetPayload({ ...adSetArgs, optimisationGoal: "THRUPLAY", ids: {} });
    expect(payload).not.toHaveProperty("promoted_object");
    expect(payload).not.toHaveProperty("start_time");
    expect(payload).not.toHaveProperty("end_time");
  });

  it("carries the dates through when given", () => {
    const payload = adSetPayload({ ...adSetArgs, startTime: "2026-10-01T00:00:00+0200", endTime: "2026-10-31T23:59:00+0200" });
    expect(payload.start_time).toBe("2026-10-01T00:00:00+0200");
    expect(payload.end_time).toBe("2026-10-31T23:59:00+0200");
  });

  it("refuses to build an ad set whose targeting the category forbids", () => {
    expect(() =>
      adSetPayload({ ...adSetArgs, purpose: "recruitment", targeting: { ...geo, age_min: 21 } }),
    ).toThrow(/cannot be targeted by age/);
  });

  it("refuses to build an ad set before the campaign, when the goal lacks what it needs", () => {
    expect(() => adSetPayload({ ...adSetArgs, ids: {} })).toThrow(/Facebook page/);
  });

  it("creates an ad paused", () => {
    const payload = adPayload({ name: "P2 static A", adSetId: "555", creativeId: "777" });
    expect(payload).toEqual({
      name: "P2 static A",
      adset_id: "555",
      creative: { creative_id: "777" },
      status: "PAUSED",
    });
  });

  it("refuses an unnamed object, or an ad with no creative", () => {
    expect(() => campaignPayload({ name: "  ", objective: "OUTCOME_LEADS", purpose: "client" })).toThrow(/needs a name/);
    expect(() => adSetPayload({ ...adSetArgs, name: "" })).toThrow(/needs a name/);
    expect(() => adPayload({ name: "a", adSetId: "1", creativeId: " " })).toThrow(/needs a creative/);
  });
});
