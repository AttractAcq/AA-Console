import { describe, expect, it } from "vitest";
import { ideaSource, pillarBrief, pillarFields, type PillarScope } from "./scope.js";

const pillar: PillarScope = {
  id: "pil-1",
  name: "Honest proof",
  premise: "Proof beats volume.",
  belongs: "Named results with a source.",
  does_not_belong: "Unattributed claims and round numbers.",
};

describe("pillarBrief", () => {
  it("is empty for an unscoped run, so the caller need not branch", () => {
    expect(pillarBrief(null)).toBe("");
  });

  it("carries the premise and both boundaries", () => {
    const brief = pillarBrief(pillar);
    expect(brief).toContain("Honest proof");
    expect(brief).toContain("Proof beats volume.");
    expect(brief).toContain("Named results with a source.");
    expect(brief).toContain("Unattributed claims and round numbers.");
  });

  // The boundary is what stops a run drifting into the next pillar by idea
  // nine, so it is an instruction rather than a line of context.
  it("tells the model to drop a good idea that belongs elsewhere", () => {
    const brief = pillarBrief(pillar);
    expect(brief).toContain("not a better idea");
    expect(brief).toContain("rather than widening the pillar");
  });
});

describe("pillarBrief names the other pillars", () => {
  const sibling = (id: string, name: string, premise: string): PillarScope => ({
    id,
    name,
    premise,
    belongs: "b",
    does_not_belong: "d",
  });

  const others = [
    sibling("p2", "In Writing, Before You Say Yes", "Everything decided before treatment starts."),
    sibling("p3", "The Same Hands", "One clinician plans it and fits it."),
  ];

  it("says nothing about siblings when there are none", () => {
    const brief = pillarBrief(pillar, []);
    expect(brief).not.toContain("OTHER PILLARS");
  });

  // The first version gave this instruction with no list of other pillars,
  // so the model could not act on it. A third of the first real run came
  // back carrying a neighbour's subject in this pillar's method.
  it("lists the other pillars, so the instruction can be followed", () => {
    const brief = pillarBrief(pillar, others);
    expect(brief).toContain("In Writing, Before You Say Yes");
    expect(brief).toContain("The Same Hands");
    expect(brief).toContain("Everything decided before treatment starts.");
  });

  it("says a subject stays with its pillar even when this method suits it", () => {
    const brief = pillarBrief(pillar, others);
    expect(brief).toContain("even when this pillar's method fits it perfectly");
  });

  it("never lists the chosen pillar among its own siblings", () => {
    const brief = pillarBrief(pillar, [...others, pillar]);
    const listed = brief.slice(brief.indexOf("OTHER PILLARS"));
    expect(listed).not.toContain(pillar.premise);
  });

  it("still confines the run when the brand has only one pillar", () => {
    const brief = pillarBrief(pillar, [pillar]);
    expect(brief).not.toContain("OTHER PILLARS");
    expect(brief).toContain("Every idea in this run sits in this pillar");
  });
});

describe("pillarFields", () => {
  it("files a scoped idea under the pillar, and names the territory after it", () => {
    expect(pillarFields(pillar, "whatever the model said")).toEqual({
      pillar_id: "pil-1",
      content_territory: "Honest proof",
    });
  });

  // Letting the model restate a territory it was just given is how
  // "Continuity and certainty" became "Continuity and Certainty".
  it("does not let the model reword a territory it was handed", () => {
    expect(pillarFields(pillar, "Honest Proof").content_territory).toBe("Honest proof");
  });

  it("keeps the model's own territory on an unscoped run", () => {
    expect(pillarFields(null, "The veneer door")).toEqual({
      pillar_id: null,
      content_territory: "The veneer door",
    });
  });

  it("stores nothing rather than an empty string", () => {
    expect(pillarFields(null, "   ").content_territory).toBeNull();
    expect(pillarFields(null, "").content_territory).toBeNull();
  });
});

describe("ideaSource", () => {
  it("names where the run came from", () => {
    expect(ideaSource("client_content_pillars")).toBe("pillar");
    expect(ideaSource("client_proof_assets")).toBe("proof");
    expect(ideaSource(null)).toBe("auto");
    expect(ideaSource(undefined)).toBe("auto");
    expect(ideaSource("client_ideas")).toBe("auto");
  });
});
