import { describe, expect, it } from "vitest";
import {
  approvalConfirmBody,
  revokeConfirmBody,
} from "./approval";

const script = {
  name: "Consult Qualifier",
  greeting: "Are you looking into replacing several teeth, or just one?",
  qualification: [
    { question: "How long has this been bothering you?" },
    { question: "What have you already tried?" },
  ],
  objections: [{ objection: "It is too expensive" }],
  guardrails: "Never quote a price. Never promise it is painless.",
};

describe("approvalConfirmBody", () => {
  it("puts name, greeting, qualification, objections and guardrails in front of the operator", () => {
    const body = approvalConfirmBody(script);
    expect(body).toMatch(/Consult Qualifier/);
    expect(body).toMatch(/Are you looking into replacing several teeth/);
    expect(body).toMatch(/2 qualification questions/);
    expect(body).toMatch(/How long has this been bothering you/);
    expect(body).toMatch(/It is too expensive/);
    expect(body).toMatch(/Never quote a price/);
  });

  it("says when the script is empty rather than implying there is something to read", () => {
    const body = approvalConfirmBody({
      name: "Empty",
      greeting: null,
      qualification: [],
      objections: [],
      guardrails: null,
    });
    expect(body).toMatch(/none written/);
    expect(body).toMatch(/no qualification questions/i);
    expect(body).toMatch(/no objections/i);
  });
});

describe("revokeConfirmBody", () => {
  it("says status will not change", () => {
    expect(revokeConfirmBody({ name: "Consult Qualifier", status: "live" })).toMatch(
      /does not change its status \(live\)/,
    );
  });
});
