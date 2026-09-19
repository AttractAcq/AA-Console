import { describe, expect, it } from "vitest";
import { askProblem, normaliseAsk } from "./draft.js";

const good = (over: Record<string, unknown> = {}) => ({
  ask: "Meets somebody who has just read the full-arch page and is deciding whether to phone. Works out whether their case is one this practice can take, and gets a time in the diary for a paid assessment. Never discusses price — the practice prices after imaging.",
  reasoning: "The offer strategy says price comes after imaging.",
  ...over,
});

describe("an ask the builder can work from", () => {
  it("accepts one that names the moment and the limit", () => {
    expect(askProblem(good(), "sales_agent")).toBeNull();
    expect(askProblem(good(), "page")).toBeNull();
  });

  it("names the missing thing rather than failing as a whole", () => {
    expect(askProblem(good({ ask: "" }), "sales_agent")).toMatch(/nothing about what the agent is for/i);
    expect(askProblem(good({ ask: "" }), "page")).toMatch(/nothing about what the page is for/i);
  });

  it("rejects an ask too thin to build from", () => {
    expect(askProblem(good({ ask: "Qualify leads." }), "sales_agent")).toMatch(/too thin to build a agent/i);
  });

  it("rejects a brief that has become the thing itself", () => {
    expect(askProblem(good({ ask: "x".repeat(1501) }), "page")).toMatch(/1501 characters/);
  });
});

// The failure mode for both of these is a paragraph that sounds thorough and
// says nothing the downstream agent did not already have. It reads the real
// offer strategy and the real ICP; it needs what is not there.
describe("marketing register instead of a brief", () => {
  it("rejects the words that mean nothing was said", () => {
    for (const phrase of [
      "Leveraging our unique value proposition to engage the ideal customer profile across every touchpoint of the journey.",
      "A best-in-class experience that seamlessly integrates with the customer journey and reflects our holistic approach.",
      "Cutting-edge positioning that creates synergy between the offer and the audience we have identified as our core.",
    ]) {
      expect(askProblem({ ask: phrase }, "sales_agent"), phrase).toMatch(/marketing register/i);
    }
  });

  it("names what the builder already reads, so the fix is obvious", () => {
    const problem = askProblem(
      { ask: "Leveraging our unique value proposition to engage the ideal customer profile at scale across channels." },
      "page",
    );
    expect(problem).toContain("offer strategy");
    expect(problem).toContain("ICP");
  });

  it("does not trip on ordinary words that merely sound corporate", () => {
    expect(
      askProblem(
        {
          ask: "Talks to somebody who asked about veneers and wants to know whether it will look obvious. Explains what the consultation covers and books one. Never makes a clinical claim about outcomes.",
        },
        "sales_agent",
      ),
    ).toBeNull();
  });
});

describe("numbers neither brief may fix", () => {
  it("rejects a price, because a number here becomes a promise in the output", () => {
    for (const figure of ["R2,500", "$99", "£40 a month"]) {
      expect(askProblem({ ask: `${good().ask} Offer it at ${figure}.` }, "page"), figure).toMatch(
        /names a figure/i,
      );
    }
  });

  it("rejects a placeholder", () => {
    expect(askProblem({ ask: `${good().ask} Mention [the guarantee].` }, "page")).toMatch(/placeholder/i);
  });
});

describe("normaliseAsk", () => {
  it("returns only the ask, dropping the reasoning meant for the operator", () => {
    const out = normaliseAsk(good());
    expect(Object.keys(out)).toEqual(["ask"]);
    expect(JSON.stringify(out)).not.toContain("offer strategy says price");
  });

  it("treats anything that is not a string as absent", () => {
    expect(normaliseAsk({ ask: 42 })).toEqual({ ask: "" });
  });
});
