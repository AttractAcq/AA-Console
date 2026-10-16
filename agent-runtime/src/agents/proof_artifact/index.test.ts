import { expect, it } from "vitest";
import { validateProofArtifactOutput } from "./index.js";

const source = "A customer wrote: The team arrived on time and completed 3 rooms in 2 days.";

it("accepts a restrained draft backed by an exact excerpt", () => {
  expect(validateProofArtifactOutput({
    supported_claim: "A customer said the team arrived on time.",
    evidence_excerpt: "The team arrived on time",
    content: "One customer reported that the team arrived on time while completing 3 rooms in 2 days.",
  }, source)).toMatchObject({
    evidenceExcerpt: "The team arrived on time",
  });
});

it("rejects invented evidence and figures before saving a model response", () => {
  expect(validateProofArtifactOutput({
    supported_claim: "On-time arrival",
    evidence_excerpt: "Every customer received same-day service",
    content: "The team arrived on time.",
  }, source)).toBeNull();
  expect(validateProofArtifactOutput({
    supported_claim: "The team has a 99% on-time rate",
    evidence_excerpt: "The team arrived on time",
    content: "A 99% on-time rate.",
  }, source)).toBeNull();
});
