import { describe, expect, it } from "vitest";

import { validateStrategy } from "./index.js";

/**
 * The rules worth refusing on, and why each one is here rather than left to
 * whatever the model felt like returning.
 *
 * Objections have a floor of two. Discovery already demands real objections;
 * this is that rule applied to the strategy pass. Copy that argues with nobody
 * convinces nobody, and a strategy listing none has not been thought about.
 *
 * Entry awareness must be a stage this strategy wrote a message for. Otherwise
 * the first thing a campaign does is reach for copy that does not exist, and
 * it finds that out at build time rather than here.
 *
 * One message per stage. Two is two strategies, and nothing downstream would
 * know which to use.
 */
const good = () => ({
  attributes: {
    problems: ["No room for a home gym", "Garage is full of junk"],
    outcomes: ["Train at home before work"],
    motivations: ["Tired of the commute to a gym"],
    triggers: ["New year, and the gym renewal just landed"],
    objections: ["Worried about damp", "Not sure it adds resale value"],
  },
  stages: [
    { stage: "problem_aware", mindset: "Knows the garage is wasted space.", message: "Your garage is a room you already own." },
    { stage: "solution_aware", mindset: "Comparing conversion against an extension.", message: "A conversion costs a third of an extension." },
  ],
  fields: {
    core_problem: "No space to train at home",
    desired_outcome: "A usable gym without leaving the house",
    purchase_trigger: "Gym renewal",
    entry_awareness: "problem_aware",
    positioning: "The room you already own",
    conversion_action: "Book a garage survey",
  },
  rationale: "Strong seasonal trigger and an obvious unused space.",
});

describe("a usable strategy", () => {
  it("separates what gets written from what gets proposed", () => {
    const out = validateStrategy(good());
    if ("error" in out) throw new Error(out.error);
    expect(out.attributes.objection).toHaveLength(2);
    expect(out.stages.map((s) => s.stage)).toEqual(["problem_aware", "solution_aware"]);
    expect(out.fields.positioning).toBe("The room you already own");
    expect(out.rationale).toBe("Strong seasonal trigger and an obvious unused space.");
  });

  it("keeps the optional stage detail optional, as null rather than empty", () => {
    const body = good();
    (body.stages[0] as Record<string, unknown>).asset_direction = "  ";
    (body.stages[1] as Record<string, unknown>).distribution_note = "Local Facebook groups";
    const out = validateStrategy(body);
    if ("error" in out) throw new Error(out.error);
    expect(out.stages[0]!.assetDirection).toBeNull();
    expect(out.stages[1]!.distributionNote).toBe("Local Facebook groups");
  });

  it("drops blank list entries rather than saving them", () => {
    const body = good();
    body.attributes.outcomes = ["Train at home", "   ", ""];
    const out = validateStrategy(body);
    if ("error" in out) throw new Error(out.error);
    expect(out.attributes.outcome).toEqual(["Train at home"]);
  });
});

describe("what it refuses", () => {
  it("refuses fewer than two objections", () => {
    const body = good();
    body.attributes.objections = ["Worried about damp"];
    expect(validateStrategy(body)).toEqual({
      error: "Name at least two objections. A buying situation with nothing standing in the way has not been thought about.",
    });
  });

  it("refuses a strategy that names no problem", () => {
    const body = good();
    body.attributes.problems = [];
    expect(validateStrategy(body))
      .toEqual({ error: "A strategy with no problems named is not a strategy." });
  });

  it("refuses an entry stage it wrote no message for", () => {
    const body = good();
    body.fields.entry_awareness = "most_aware";
    expect(validateStrategy(body)).toEqual({
      error: "Entry awareness is most_aware, but no message was written for that stage.",
    });
  });

  it("refuses two messages for one stage", () => {
    const body = good();
    body.stages.push({ ...body.stages[0]! });
    expect(validateStrategy(body)).toEqual({ error: "problem_aware was given a message twice." });
  });

  it("refuses a stage that is not an awareness stage", () => {
    const body = good();
    body.stages[1]!.stage = "curious";
    expect(validateStrategy(body))
      .toEqual({ error: '"curious" is not one of the awareness stages.' });
  });

  it("refuses a stage missing its mindset or its message", () => {
    for (const key of ["mindset", "message"] as const) {
      const body = good();
      body.stages[0]![key] = "  ";
      expect(validateStrategy(body))
        .toEqual({ error: "problem_aware needs both the mindset and the message." });
    }
  });

  it("refuses an empty proposed field", () => {
    const body = good();
    body.fields.positioning = "   ";
    expect(validateStrategy(body))
      .toEqual({ error: "The proposed positioning came back empty." });
  });

  it("refuses an over-long attribute rather than letting the column do it", () => {
    const body = good();
    body.attributes.problems = ["x".repeat(2001)];
    expect(validateStrategy(body))
      .toEqual({ error: "The problem list came back as something other than a list of sentences." });
  });

  it("refuses shapes that are not a strategy at all", () => {
    expect(validateStrategy(null))
      .toEqual({ error: "The strategy came back in a shape this cannot read." });
    const noRationale = good();
    noRationale.rationale = " ";
    expect(validateStrategy(noRationale))
      .toEqual({ error: "The strategy came back with no rationale." });
    const noStages = good();
    noStages.stages = [];
    expect(validateStrategy(noStages))
      .toEqual({ error: "The strategy came back with no awareness stages." });
  });
});
