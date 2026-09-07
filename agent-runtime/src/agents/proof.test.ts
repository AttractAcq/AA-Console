import { describe, expect, it } from "vitest";
import { renderProof, type ProofRecord } from "./proof.js";

const rec = (over: Partial<ProofRecord> = {}): ProofRecord => ({
  ref_number: "HD-0019",
  proof_type: "customer_result",
  title: "Implant patient",
  claim: "Four implants placed in one visit, no pain reported at six months",
  evidence: "Named Google review plus the clinical record",
  avatar_relevance: "Full-arch patients over 45",
  services: "Implants",
  strength: "high",
  body: null,
  source: "Google review",
  captured_on: "2026-03-01",
  ...over,
});

describe("how proof reaches an agent", () => {
  it("leads with the reference, type and strength, so a brief can cite it", () => {
    const out = renderProof([rec()]);
    expect(out).toContain("HD-0019 · customer_result · strength high");
  });

  it("gives the claim and the evidence separately", () => {
    const out = renderProof([rec()]);
    expect(out).toContain("Claim: Four implants placed in one visit");
    expect(out).toContain("Evidence: Named Google review plus the clinical record");
  });

  // Falls back rather than printing an empty label — a record written before
  // Proof & Asset OS has a title and a body and nothing else.
  it("falls back to title and body for a record with no claim yet", () => {
    const out = renderProof([rec({ claim: null, evidence: null, title: "January result", body: "Closed two retainers" })]);
    expect(out).toContain("Claim: January result");
    expect(out).toContain("Evidence: Closed two retainers");
  });

  it("omits a field it has nothing for instead of printing a blank", () => {
    const out = renderProof([rec({ services: null, captured_on: null })]);
    expect(out).not.toMatch(/Service:/);
    expect(out).not.toMatch(/Captured:/);
  });
});

describe("when there is nothing to cite", () => {
  // The distinction that matters: "none exists" and "some exists, nobody
  // cleared it" call for different action, and only the second is a job
  // somebody can go and do.
  it("says none is on file when none is", () => {
    const out = renderProof([], { held: 0 });
    expect(out).toMatch(/None on file/);
    expect(out).not.toMatch(/not cleared/);
  });

  it("says so when proof exists but is not cleared", () => {
    const out = renderProof([], { held: 2 });
    expect(out).toMatch(/2 proof records are on file but not cleared/);
  });

  it("gets the grammar right for a single held record", () => {
    expect(renderProof([], { held: 1 })).toMatch(/1 proof record is on file/);
  });

  // The instruction, not just the fact. A model told "none" without being
  // told what to do writes around the gap and implies a claim anyway.
  it("tells the agent what to do about it", () => {
    for (const held of [0, 2]) {
      expect(renderProof([], { held })).toMatch(/must work without a proof claim/);
      expect(renderProof([], { held })).toMatch(/Say so rather than implying one/);
    }
  });
});
