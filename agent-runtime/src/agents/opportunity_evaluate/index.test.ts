import { describe, expect, it } from "vitest";

import { validateEvaluation } from "./index.js";

/**
 * What this validator exists to refuse.
 *
 * The expensive failure is a PARTIAL score. score_market_opportunity_v6
 * rejects an incomplete factor set, so a proposal missing one factor would be
 * a card that can never be accepted — a dead end a person finds only by
 * clicking it and reading a database error. Refusing it here means the run
 * fails loudly with a reason instead.
 *
 * The other one worth refusing is a score with no argument behind it. A person
 * accepting a proposal is asserting the thing that unlocks spend; if all they
 * have is a number, they are rubber-stamping rather than deciding.
 */
const FACTORS = [
  { factor: "available_proof", weight: 0.15, label: "Available proof" },
  { factor: "commercial_urgency", weight: 0.15, label: "Commercial urgency" },
  { factor: "economic_value", weight: 0.2, label: "Economic value" },
] as const;

const good = () => ({
  scores: [
    { factor: "available_proof", score: 60, reasoning: "Two case studies, neither recent." },
    { factor: "commercial_urgency", score: 70, reasoning: "Winter drives the enquiry." },
    { factor: "economic_value", score: 90, reasoning: "Highest-margin job they do." },
  ],
  rationale: "Strong value, urgency is seasonal, proof is the gap.",
});

describe("a usable evaluation", () => {
  it("takes the factors and their reasoning apart", () => {
    const out = validateEvaluation(good(), FACTORS);
    expect(out).toEqual({
      factors: { available_proof: 60, commercial_urgency: 70, economic_value: 90 },
      reasoning: {
        available_proof: "Two case studies, neither recent.",
        commercial_urgency: "Winter drives the enquiry.",
        economic_value: "Highest-margin job they do.",
      },
      rationale: "Strong value, urgency is seasonal, proof is the gap.",
    });
  });

  it("accepts the ends of the range, which are real answers", () => {
    const body = good();
    body.scores[0]!.score = 0;
    body.scores[2]!.score = 100;
    const out = validateEvaluation(body, FACTORS);
    expect("error" in out).toBe(false);
  });
});

describe("what it refuses", () => {
  it("names every factor the model left out", () => {
    const body = good();
    body.scores = [body.scores[0]!];
    expect(validateEvaluation(body, FACTORS)).toEqual({
      error: "Every factor has to be scored. Missing: commercial_urgency, economic_value.",
    });
  });

  it("refuses a factor this system does not have", () => {
    const body = good();
    body.scores[1]!.factor = "gut_feel";
    expect(validateEvaluation(body, FACTORS))
      .toEqual({ error: '"gut_feel" is not one of the scoring factors.' });
  });

  it("refuses a score that is not a whole number in range", () => {
    for (const bad of [-1, 101, 72.5, "80", null, undefined]) {
      const body = good();
      (body.scores[0] as { score: unknown }).score = bad;
      expect(validateEvaluation(body, FACTORS)).toEqual({
        error: "available_proof came back as something other than a whole number from 0 to 100.",
      });
    }
  });

  it("refuses a factor scored with no reasoning", () => {
    const body = good();
    body.scores[2]!.reasoning = "   ";
    expect(validateEvaluation(body, FACTORS))
      .toEqual({ error: "economic_value was scored with no reasoning." });
  });

  it("refuses an evaluation with no overall rationale", () => {
    const body = good();
    body.rationale = "  ";
    expect(validateEvaluation(body, FACTORS))
      .toEqual({ error: "The evaluation came back with no rationale." });
  });

  it("refuses shapes that are not an evaluation at all", () => {
    expect(validateEvaluation(null, FACTORS))
      .toEqual({ error: "The evaluation came back in a shape this cannot read." });
    expect(validateEvaluation({ rationale: "fine" }, FACTORS))
      .toEqual({ error: "The evaluation came back with no factor scores." });
    expect(validateEvaluation({ rationale: "fine", scores: [7] }, FACTORS))
      .toEqual({ error: "One of the factor scores came back in a shape this cannot read." });
  });
});
