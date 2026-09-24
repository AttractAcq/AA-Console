import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_TEMPLATES,
  TEMPLATE_CTAS,
  allowedCtas,
  NO_TEMPLATE,
  derivedNeeds,
  templateColumns,
  templateFor,
  templateOptions,
  templateSummary,
} from "./campaignTemplates";

describe("the library the picker reads", () => {
  it("holds the sixteen, with unique codes", () => {
    expect(CAMPAIGN_TEMPLATES).toHaveLength(16);
    expect(new Set(CAMPAIGN_TEMPLATES.map((t) => t.code)).size).toBe(16);
  });

  it("finds one by code and nothing by anything else", () => {
    expect(templateFor("P3")?.name).toBe("Prospect to DM");
    expect(templateFor("p3")).toBeNull();
    expect(templateFor(null)).toBeNull();
    expect(templateFor("")).toBeNull();
  });
});

describe("the picker's options", () => {
  // FieldControl renders its own empty option for a select. A blank in here
  // would be the second one, and both would set the field to "".
  it("offers the sixteen and no blank of its own", () => {
    expect(templateOptions()).toHaveLength(16);
    expect(templateOptions().some((o) => o.value === "")).toBe(false);
    expect(NO_TEMPLATE.value).toBe("");
  });

  it("keeps a template that needs setup selectable, and says so", () => {
    const r1 = templateOptions().find((o) => o.value === "R1");
    expect(r1).toBeDefined();
    expect(r1!.label).toContain("needs setup first");
  });

  it("does not warn about a template that can run from a standing start", () => {
    expect(templateOptions().find((o) => o.value === "P2")!.label).not.toContain("needs setup");
  });
});

describe("what a chosen template writes", () => {
  it("writes nothing when none is chosen", () => {
    expect(templateColumns("")).toBeNull();
    expect(templateColumns(null)).toBeNull();
    expect(templateColumns("nonsense")).toBeNull();
  });

  it("writes the template, the states and the event", () => {
    expect(templateColumns("P2")).toEqual({
      template: "P2",
      entry_state: "S0",
      exit_state: "S3",
      optimisation_event: "LEAD_GENERATION",
      needs_landing_page: false,
      needs_sales_agent: false,
    });
  });

  it("requires a sales agent for the one that sends people into a DM", () => {
    expect(templateColumns("P3")).toMatchObject({
      needs_sales_agent: true,
      needs_landing_page: false,
    });
    const needing = CAMPAIGN_TEMPLATES.filter((t) => derivedNeeds(t).needs_sales_agent);
    expect(needing.map((t) => t.code)).toEqual(["P3"]);
  });

  it("requires a landing page wherever the ad points at one", () => {
    expect(templateColumns("R1")).toMatchObject({ needs_landing_page: true });
    expect(templateColumns("P5")).toMatchObject({ needs_landing_page: true });
  });

  it("leaves the event unset on a template that inherits one", () => {
    expect(templateColumns("X1")).toMatchObject({ optimisation_event: null });
  });
});

describe("the line under the picker", () => {
  it("says what it does, who it moves, and what it needs", () => {
    const summary = templateSummary(templateFor("P3")!);
    expect(summary).toContain("Lowest-friction");
    expect(summary).toContain("Stranger → Identified");
    expect(summary).toContain("Needs a sales agent");
  });

  it("names the prerequisite when there is one", () => {
    expect(templateSummary(templateFor("R1")!)).toContain("P1 or P4 running 14 days");
  });

  it("says nothing about needs or setup when there are none", () => {
    const summary = templateSummary(templateFor("P2")!);
    expect(summary).not.toContain("Needs");
    expect(summary).toMatch(/Moves people Stranger → Identified\.$/);
  });
});

describe("TEMPLATE_CTAS", () => {
  it("matches the buttons the Meta build checks against", async () => {
    const runtime = await import("../../agent-runtime/src/campaigns/templates");
    const fromRuntime = Object.fromEntries(runtime.CAMPAIGN_TEMPLATES.map((t) => [t.code, [...t.ctas]]));
    expect(TEMPLATE_CTAS).toEqual(fromRuntime);
  });

  it("takes a mirroring template's buttons from the one it mirrors", () => {
    expect(allowedCtas("X2", "R1")).toEqual(["BOOK_NOW", "SHOP_NOW", "LEARN_MORE"]);
    expect(allowedCtas("X2", null)).toEqual([]);
    expect(allowedCtas("O2")).toEqual(["SIGN_UP"]);
    expect(allowedCtas(null)).toEqual([]);
  });
});
