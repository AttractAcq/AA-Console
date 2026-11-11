import { describe, expect, it } from "vitest";

import { platformFor, sweepSteps } from "./plan.js";

/**
 * The step graph, which is the whole of what a composer decides.
 *
 * Two properties matter most. The chain per piece has to match the daily
 * content package's exactly -- idea, then brief from that idea, then creative
 * from that brief -- because those agents already understand that shape and
 * the reconciler already drives it. And ideas have to run in sequence rather
 * than in parallel, which is also what the daily package does: each idea is
 * written knowing what the earlier ones said, so a campaign gets genuinely
 * distinct pieces instead of several models' first instinct.
 */
describe("which platform a campaign's pieces go to", () => {
  it("takes the first channel that is really a post platform", () => {
    expect(platformFor(["email", "instagram", "facebook"])).toBe("instagram");
    expect(platformFor(["LinkedIn"])).toBe("linkedin");
  });

  it("reads meta as instagram, because meta is not a post destination", () => {
    // The planner writes "meta" for Meta campaigns, which is Facebook and
    // Instagram rather than somewhere a post goes. The daily package uses
    // instagram for Meta work.
    expect(platformFor(["meta"])).toBe("instagram");
  });

  it("refuses to invent one", () => {
    // A campaign whose channels name no post platform has nowhere to publish.
    // Saying so beats composing a chain that fails after paying for every
    // idea and brief in it.
    expect(platformFor(["google_ads", "search"])).toBeNull();
    expect(platformFor([])).toBeNull();
    expect(platformFor(null)).toBeNull();
  });
});

describe("the chain a plan implies", () => {
  const base = { platform: "instagram" as const, campaignId: "camp-1" };
  const pieces = (organic: number, paid: number) => [
    ...Array.from({ length: organic }, () => ({ acquisition_route: "organic" as const, media_type: "image" as const, content_format: "single" as const })),
    ...Array.from({ length: paid }, () => ({ acquisition_route: "paid" as const, media_type: "video" as const, content_format: "reel" as const })),
  ];

  it("builds idea, brief and create for each piece", () => {
    const steps = sweepSteps({ ...base, pieces: pieces(2, 0) });
    expect(steps.map((s) => s.stepKey)).toEqual([
      "piece1_idea", "piece1_brief", "piece1_create",
      "piece2_idea", "piece2_brief", "piece2_create",
    ]);
    expect(steps.map((s) => s.agentKey)).toEqual([
      "ideation", "brief", "creative_build",
      "ideation", "brief", "creative_build",
    ]);
  });

  it("chains each piece's brief and creative to its own idea", () => {
    const steps = sweepSteps({ ...base, pieces: pieces(1, 0) });
    const [idea, brief, create] = steps;
    expect(idea!.dependencies).toEqual([]);
    expect(idea!.usesClientAsInput).toBe(true);
    expect(idea!.inputFromStepKey).toBeNull();
    expect(brief).toMatchObject({
      dependencies: ["piece1_idea"],
      inputTable: "client_ideas",
      inputFromStepKey: "piece1_idea",
      usesClientAsInput: false,
    });
    expect(create).toMatchObject({
      dependencies: ["piece1_brief"],
      inputTable: "client_briefs",
      inputFromStepKey: "piece1_brief",
      usesClientAsInput: false,
    });
  });

  it("runs ideas in sequence so each sees the ones before it", () => {
    const steps = sweepSteps({ ...base, pieces: pieces(3, 0) });
    const ideas = steps.filter((s) => s.agentKey === "ideation");
    expect(ideas.map((s) => s.dependencies)).toEqual([
      [], ["piece1_idea"], ["piece2_idea"],
    ]);
  });

  it("carries each piece's route, so a both-campaign's halves are distinguishable", () => {
    // Migration 302 put acquisition_route on client_ideas for exactly this.
    const steps = sweepSteps({ ...base, pieces: pieces(2, 1) });
    const routes = steps
      .filter((s) => s.agentKey === "ideation")
      .map((s) => s.inputParams.acquisition_route);
    expect(routes).toEqual(["organic", "organic", "paid"]);
  });

  it("names the campaign and the platform on every idea", () => {
    const steps = sweepSteps({ ...base, pieces: pieces(1, 1) });
    for (const idea of steps.filter((s) => s.agentKey === "ideation")) {
      expect(idea.inputParams).toMatchObject({
        idea_count: 1,
        campaign_id: "camp-1",
        target_platform: "instagram",
        media_type: idea.inputParams.acquisition_route === "paid" ? "video" : "image",
        content_format: idea.inputParams.acquisition_route === "paid" ? "reel" : "single",
      });
    }
  });

  it("composes nothing from a plan with no pieces", () => {
    expect(sweepSteps({ ...base, pieces: pieces(0, 0) })).toEqual([]);
  });

  it("gives every step a key the engine will accept", () => {
    // add_workflow_agent_step requires ^[a-z][a-z0-9_]{0,79}$ and refuses
    // anything else, so a key this composer invents has to match.
    const steps = sweepSteps({ ...base, pieces: pieces(4, 4) });
    for (const step of steps) {
      expect(step.stepKey).toMatch(/^[a-z][a-z0-9_]{0,79}$/);
    }
    // And they are unique: a repeated key is an idempotency conflict.
    expect(new Set(steps.map((s) => s.stepKey)).size).toBe(steps.length);
  });

  it("sets exactly one input source per step, which the engine enforces", () => {
    // add_workflow_agent_step refuses when (input_id is not null) equals
    // (input_from_step_key is not null) -- exactly one, never both or neither.
    const steps = sweepSteps({ ...base, pieces: pieces(2, 2) });
    for (const step of steps) {
      expect(step.usesClientAsInput === (step.inputFromStepKey === null)).toBe(true);
    }
  });

  it("only ever depends on a step it has already added", () => {
    // The engine refuses a dependency that does not exist yet, so the chain
    // has to be written front to back.
    const steps = sweepSteps({ ...base, pieces: pieces(3, 2) });
    const seen = new Set<string>();
    for (const step of steps) {
      for (const dep of step.dependencies) expect(seen.has(dep)).toBe(true);
      seen.add(step.stepKey);
    }
  });

  it("uses its input source only from a direct dependency", () => {
    // Another of the engine's rules: input_from_step_key must be in
    // dependencies.
    const steps = sweepSteps({ ...base, pieces: pieces(2, 1) });
    for (const step of steps) {
      if (step.inputFromStepKey !== null) {
        expect(step.dependencies).toContain(step.inputFromStepKey);
      }
    }
  });
});
