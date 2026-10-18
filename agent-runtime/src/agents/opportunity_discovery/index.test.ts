import { describe, expect, it } from "vitest";

import { validateDiscoveryOutput, type SourceRecord } from "./index.js";

/**
 * The validator is where this agent earns its place.
 *
 * A model asked for market segments will produce them whether or not the
 * client's intelligence supports any, and the result reads like research
 * either way. These tests are almost entirely about refusing that: a segment
 * with no grounding, a statistic nobody measured, a buying situation with
 * nothing standing in the way.
 */

const SOURCES: SourceRecord[] = [
  {
    ref: "R1", id: "11111111-1111-4111-8111-111111111111", domain: "market",
    title: "Premium home gym market",
    body: "Affluent homeowners in metropolitan areas. Average install 12 weeks.",
  },
  {
    ref: "R2", id: "22222222-2222-4222-8222-222222222222", domain: "icp",
    title: "Core ICP", body: "Homeowners with large properties and underused rooms.",
  },
];

const ok = () => ({
  name: "Garage-to-Gym Conversion",
  micro_market: "Homeowners with an underused garage",
  buying_situation: "Mid-renovation, deciding what the garage becomes",
  core_problem: "Their training space is poor and inconvenient",
  desired_outcome: "A dedicated private gym at home",
  purchase_trigger: "A renovation already under way",
  entry_awareness: "problem_aware",
  positioning: "That unused garage could become the training space you have always wanted",
  conversion_action: "Book a garage-to-gym design consultation",
  problems: ["Nowhere good to train", "Equipment in the way"],
  outcomes: ["A room built for training"],
  triggers: ["Renovation"],
  objections: ["Flooring", "Noise", "Total cost"],
  proof_requirements: ["A completed garage conversion with costs"],
  from_records: ["R1", "R2"],
});

const run = (opportunities: unknown[]) =>
  validateDiscoveryOutput({ opportunities }, SOURCES);

describe("what it accepts", () => {
  it("takes a grounded opportunity and resolves its references to record ids", () => {
    const result = run([ok()]);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.opportunities[0]).toMatchObject({
      name: "Garage-to-Gym Conversion",
      entryAwareness: "problem_aware",
      sourceRecordIds: [SOURCES[0]!.id, SOURCES[1]!.id],
    });
  });

  it("keeps a number the client's own intelligence states", () => {
    // "12 weeks" is in R1. Repeating a fact back is not inventing one.
    const result = run([{ ...ok(), buying_situation: "Facing a 12 week build" }]);
    expect("error" in result).toBe(false);
  });

  it("is case-insensitive about reference codes", () => {
    const result = run([{ ...ok(), from_records: ["r1"] }]);
    expect("error" in result).toBe(false);
  });
});

describe("what it refuses", () => {
  it("an opportunity grounded in nothing", () => {
    expect(run([{ ...ok(), from_records: [] }])).toMatchObject({
      error: expect.stringContaining("does not say which intelligence"),
    });
  });

  it("a reference the model invented", () => {
    expect(run([{ ...ok(), from_records: ["R9"] }])).toMatchObject({
      error: expect.stringContaining("R9, which was not one of the records"),
    });
  });

  it("a market statistic that appears nowhere in the source", () => {
    // The whole failure mode: a fabricated number reads exactly like a
    // researched one once it is in the database.
    expect(run([{ ...ok(), micro_market: "The 40% of homeowners with a double garage" }])).toMatchObject({
      error: expect.stringContaining("40%"),
    });
  });

  it("a buying situation with nothing standing in the way", () => {
    expect(run([{ ...ok(), objections: [] }])).toMatchObject({
      error: expect.stringContaining("no objections"),
    });
  });

  it("an awareness stage that is not one of the five", () => {
    // Guards against the templates' S0-S6 arriving here by mistake; they are
    // a different axis and would be silently wrong.
    expect(run([{ ...ok(), entry_awareness: "S2" }])).toMatchObject({
      error: expect.stringContaining("not one of the five"),
    });
  });

  it("the same opportunity described twice", () => {
    expect(run([ok(), { ...ok(), micro_market: "Phrased differently" }])).toMatchObject({
      error: expect.stringContaining("both called"),
    });
  });

  it("a missing field, naming which one and where", () => {
    expect(run([{ ...ok(), core_problem: "   " }])).toMatchObject({
      error: "Opportunity 1 has no core_problem.",
    });
  });

  it("nothing at all, and more than a person would read", () => {
    expect(run([])).toMatchObject({ error: "No opportunities were returned." });
    const many = Array.from({ length: 9 }, (_, i) => ({ ...ok(), name: `Opportunity ${i}` }));
    expect(run(many)).toMatchObject({ error: expect.stringContaining("8 is the limit") });
  });
});
