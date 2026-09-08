import { describe, expect, it } from "vitest";
import {
  definitionProblem,
  definitionSummary,
  normaliseObjections,
  normaliseQualification,
  placeholderIn,
  type SalesAgentDefinition,
} from "./definition.js";

const step = (question: string) => ({
  question,
  why: "establishes fit",
  good_answer: "a real buyer says this",
  disqualifier: "a browser says this",
});

const good = (): SalesAgentDefinition => ({
  greeting: "Hi — are you looking into replacing several teeth, or just one?",
  system_prompt: "x".repeat(500),
  qualification: [step("How long has this been bothering you?"), step("What have you already tried?"), step("Who else is part of this decision?")],
  objections: [{ objection: "It is too expensive", response: "Talk about what it replaces" }],
  booking_rule: "Book once they have named a timeframe and confirmed they can attend in person.",
  escalation_rule: "Hand over on any clinical question, any complaint, or any mention of a refund.",
  guardrails: "Never quote a price. Never promise a treatment time. Never say the work is painless.",
});

describe("definitionProblem", () => {
  it("accepts an agent that can actually run", () => {
    expect(definitionProblem(good())).toBeNull();
  });

  it("rejects an agent with no opening line", () => {
    expect(definitionProblem({ ...good(), greeting: "" })).toMatch(/no opening line/i);
  });

  it("rejects operating instructions too thin to run on", () => {
    expect(definitionProblem({ ...good(), system_prompt: "Be helpful." })).toMatch(/too thin/i);
  });

  it("rejects too few qualification questions to separate a buyer from a browser", () => {
    const problem = definitionProblem({ ...good(), qualification: [step("One?"), step("Two?")] });
    expect(problem).toMatch(/2 qualification questions/);
    expect(problem).toMatch(/cannot separate a buyer from a browser/);
  });

  it("rejects an agent that does not know when to ask for the appointment", () => {
    expect(definitionProblem({ ...good(), booking_rule: "" })).toMatch(/no booking rule/i);
  });

  it("rejects an agent with no way out to a person", () => {
    expect(definitionProblem({ ...good(), escalation_rule: "" })).toMatch(/escalation rule/i);
  });

  it("rejects an agent that has not been told what it may never promise", () => {
    expect(definitionProblem({ ...good(), guardrails: "" })).toMatch(/guardrails/i);
  });

  it("rejects a placeholder a visitor would read, in the greeting", () => {
    const problem = definitionProblem({ ...good(), greeting: "Hi, welcome to [CLIENT NAME]!" });
    expect(problem).toMatch(/\[CLIENT NAME\]/);
  });

  it("rejects a placeholder hiding in a qualification question", () => {
    const def = good();
    def.qualification[1] = step("How far are you from [LOCATION]?");
    expect(definitionProblem(def)).toMatch(/\[LOCATION\]/);
  });

  it("rejects a template variable in an objection response", () => {
    const def = good();
    def.objections = [{ objection: "Too far", response: "We are near {{suburb}}" }];
    expect(definitionProblem(def)).toMatch(/\{\{suburb\}\}/);
  });

  it("does not mistake ordinary prose for a placeholder", () => {
    const def = good();
    def.greeting = "Hi — are you replacing one tooth (or several)?";
    expect(definitionProblem(def)).toBeNull();
  });
});

describe("placeholderIn", () => {
  it("finds a bracket placeholder", () => {
    expect(placeholderIn("Call [PRACTICE] today")).toBe("[PRACTICE]");
  });
  it("finds a handlebars variable", () => {
    expect(placeholderIn("Hello {{first_name}}")).toBe("{{first_name}}");
  });
  it("returns null for clean text", () => {
    expect(placeholderIn("Hello — how can I help?")).toBeNull();
  });
});

describe("normaliseQualification", () => {
  it("drops a step with no question, because a blank prompt cannot be asked", () => {
    const out = normaliseQualification([
      { question: "Real question?", why: "a", good_answer: "b", disqualifier: "c" },
      { why: "orphaned", good_answer: "", disqualifier: "" },
      { question: "   ", why: "blank" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.question).toBe("Real question?");
  });

  it("keeps a question that is missing only its reasoning", () => {
    const out = normaliseQualification([{ question: "Still useful?" }]);
    expect(out).toEqual([{ question: "Still useful?", why: "", good_answer: "", disqualifier: "" }]);
  });

  it("returns empty for anything that is not a list", () => {
    expect(normaliseQualification("nope")).toEqual([]);
    expect(normaliseQualification(undefined)).toEqual([]);
    expect(normaliseQualification([null, 3, "x"])).toEqual([]);
  });
});

describe("normaliseObjections", () => {
  it("drops an objection with no answer, since an unanswered objection is not handled", () => {
    const out = normaliseObjections([
      { objection: "Too expensive", response: "Here is why" },
      { objection: "Too far", response: "  " },
      { response: "orphan" },
    ]);
    expect(out).toEqual([{ objection: "Too expensive", response: "Here is why" }]);
  });
});

describe("definitionSummary", () => {
  it("numbers the questions so the agent is legible without expanding anything", () => {
    const summary = definitionSummary(good());
    expect(summary).toContain("Qualifies on 3 questions");
    expect(summary).toContain("1. How long has this been bothering you?");
    expect(summary).toContain("Hands over when:");
  });
});
