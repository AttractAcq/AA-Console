import { describe, expect, it } from "vitest";
import { META_CTAS } from "../meta/cta.js";
import {
  AUDIENCE_STATES,
  CAMPAIGN_TEMPLATES,
  META_OBJECTIVES,
  OPTIMISATION_GOALS,
  TEMPLATE_CODES,
  availableFromStart,
  templateFor,
  templateProblem,
} from "./templates.js";

describe("the library", () => {
  it("holds the sixteen templates from the matrix", () => {
    expect(CAMPAIGN_TEMPLATES).toHaveLength(16);
    expect(TEMPLATE_CODES).toEqual([
      "P1", "P2", "P3", "P4", "P5",
      "R1", "R2", "R3", "R4",
      "C1", "C2", "C3",
      "O1", "O2",
      "X1", "X2",
    ]);
  });

  it("gives every code exactly one template", () => {
    expect(new Set(TEMPLATE_CODES).size).toBe(TEMPLATE_CODES.length);
  });

  it("finds a template by code, and nothing by a code that is not one", () => {
    expect(templateFor("P3")?.name).toBe("Prospect to DM");
    expect(templateFor("P9")).toBeNull();
    expect(templateFor("")).toBeNull();
  });

  it("states entry and exit states Meta and the funnel both know", () => {
    for (const t of CAMPAIGN_TEMPLATES) {
      expect(AUDIENCE_STATES).toContain(t.entry);
      expect(AUDIENCE_STATES).toContain(t.exit);
    }
  });

  it("gives every template a guardrail and a way to score it", () => {
    for (const t of CAMPAIGN_TEMPLATES) {
      expect(t.guardrail.length, `${t.code} guardrail`).toBeGreaterThan(0);
      expect(t.kpi.length, `${t.code} kpi`).toBeGreaterThan(0);
      expect(t.purpose.length, `${t.code} purpose`).toBeGreaterThan(0);
    }
  });
});

describe("what gets sent to Meta", () => {
  it("gives every template that runs on its own an objective and an event", () => {
    for (const t of CAMPAIGN_TEMPLATES.filter((x) => !x.mirrors)) {
      expect(t.objective, `${t.code} objective`).not.toBeNull();
      expect(t.optimisation, `${t.code} optimisation`).not.toBeNull();
      expect(META_OBJECTIVES).toContain(t.objective!);
      expect(OPTIMISATION_GOALS).toContain(t.optimisation!);
    }
  });

  it("leaves a mirroring template's objective unset, because it inherits one", () => {
    for (const t of CAMPAIGN_TEMPLATES.filter((x) => x.mirrors)) {
      expect(t.objective, `${t.code} objective`).toBeNull();
      expect(t.optimisation, `${t.code} optimisation`).toBeNull();
    }
    expect(CAMPAIGN_TEMPLATES.filter((t) => t.mirrors).map((t) => t.code)).toEqual(["X1", "X2"]);
  });

  it("only offers buttons Meta has", () => {
    for (const t of CAMPAIGN_TEMPLATES) {
      for (const cta of t.ctas) expect(META_CTAS, `${t.code}`).toContain(cta);
    }
  });

  it("offers SEND_MESSAGE only where a message thread is the destination", () => {
    for (const t of CAMPAIGN_TEMPLATES) {
      if ((t.ctas as readonly string[]).includes("SEND_MESSAGE")) {
        expect(t.destination, `${t.code}`).toBe("message");
      }
    }
    expect(templateFor("P3")?.ctas).toEqual(["SEND_MESSAGE"]);
  });

  it("gives no button to the templates that deliberately do not ask for a click", () => {
    expect(templateFor("P4")?.ctas).toEqual([]);
    expect(templateFor("P4")?.destination).toBe("none");
    expect(templateFor("R4")?.ctas).toEqual([]);
  });
});

describe("sequencing", () => {
  it("offers only the templates a client with no history can run", () => {
    expect(availableFromStart().map((t) => t.code)).toEqual(["P1", "P2", "P3", "P4", "X2"]);
  });

  it("holds back everything that needs a pool, a list or a date", () => {
    for (const code of ["R1", "R2", "R3", "C1", "C2", "C3", "O1", "O2", "X1", "P5", "R4"]) {
      expect(templateFor(code)!.prerequisite, code).not.toBeNull();
    }
  });
});

describe("templateProblem", () => {
  const p1 = templateFor("P1")!;
  const p3 = templateFor("P3")!;
  const p4 = templateFor("P4")!;
  const x1 = templateFor("X1")!;
  const x2 = templateFor("X2")!;

  it("accepts a template with a button its destination can serve", () => {
    expect(templateProblem(p3, { cta: "SEND_MESSAGE" })).toBeNull();
    expect(templateProblem(p1, { cta: "LEARN_MORE" })).toBeNull();
  });

  it("accepts a template with no button chosen at all", () => {
    expect(templateProblem(p1, {})).toBeNull();
    expect(templateProblem(p4, { cta: "" })).toBeNull();
    expect(templateProblem(p1, { cta: null })).toBeNull();
  });

  it("refuses a button that is not Meta's", () => {
    expect(templateProblem(p1, { cta: "APPLY_TODAY" })).toContain("not a Meta call-to-action");
  });

  it("refuses a button the destination cannot serve", () => {
    const problem = templateProblem(p1, { cta: "SEND_MESSAGE" });
    expect(problem).toContain("SEND_MESSAGE cannot point at profile");
    expect(problem).toContain("LEARN_MORE");
  });

  it("refuses a button on a template that runs without one", () => {
    expect(templateProblem(p4, { cta: "LEARN_MORE" })).toContain("runs without a call-to-action");
  });

  it("refuses a mirroring template that does not say what it mirrors", () => {
    expect(templateProblem(x1, {})).toContain("must name one");
    expect(templateProblem(x1, { mirrorOf: "   " })).toContain("must name one");
  });

  it("accepts a mirroring template pointed at a real one", () => {
    expect(templateProblem(x1, { mirrorOf: "P2" })).toBeNull();
    expect(templateProblem(x2, { mirrorOf: "P1", cta: "SEND_MESSAGE" })).toBeNull();
  });

  it("refuses a mirror of a code that is not a template", () => {
    expect(templateProblem(x1, { mirrorOf: "P9" })).toContain("not a campaign template");
  });

  it("refuses a mirror of a template that has no objective to inherit", () => {
    expect(templateProblem(x1, { mirrorOf: "X2" })).toContain("no objective of its own");
  });
});
