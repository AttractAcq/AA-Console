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

it("will not let a count in the source license a rate in the output", () => {
  // The pattern used to drop a trailing %, so "99" matched "99%" and a
  // number of jobs was enough to justify a percentage nobody measured.
  const counted = "The team completed 99 jobs. The team arrived on time.";
  expect(validateProofArtifactOutput({
    supported_claim: "The team has a 99% on-time rate",
    evidence_excerpt: "The team arrived on time",
    content: "A 99% on-time rate.",
  }, counted)).toBeNull();
  // The same figure, stated as the source states it, is still fine.
  expect(validateProofArtifactOutput({
    supported_claim: "The team completed 99 jobs",
    evidence_excerpt: "The team arrived on time",
    content: "99 jobs completed.",
  }, counted)).not.toBeNull();
});
