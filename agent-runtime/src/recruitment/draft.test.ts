import { describe, expect, it } from "vitest";
import { draftProblem, normaliseDraft, DRAFT_FIELDS } from "./draft.js";

const good = (over: Record<string, unknown> = {}) => ({
  title: "Editor — vertical cutdowns for dental practices",
  hook: "Cut the work that actually ships",
  script:
    "Attract Acquisition is hiring an editor for vertical cutdowns. You take an approved brief and turn it into a still that looks like the practice it belongs to. Durban hours, start in January.",
  call_to_action: "Apply now",
  visual_direction:
    "A quiet editing desk, documentary light, a real timeline on screen. No stock handshakes.",
  premise: "We hire editors who finish assets, not decorate briefs.",
  ...over,
});

describe("a draft that can go in front of an applicant", () => {
  it("accepts a complete brief", () => {
    expect(draftProblem(good())).toBeNull();
  });

  it("does not require a premise, which is internal framing", () => {
    expect(draftProblem(good({ premise: "" }))).toBeNull();
  });
});

describe("what makes a draft unusable", () => {
  it("names the missing field rather than failing as a whole", () => {
    expect(draftProblem(good({ title: "" }))).toMatch(/no title/i);
    expect(draftProblem(good({ hook: "" }))).toMatch(/no headline/i);
    expect(draftProblem(good({ script: "" }))).toMatch(/no primary text/i);
    expect(draftProblem(good({ call_to_action: "" }))).toMatch(/no call to action/i);
    expect(draftProblem(good({ visual_direction: "" }))).toMatch(/what the image should show/i);
  });

  it("rejects primary text too thin to be an ad", () => {
    expect(draftProblem(good({ script: "We are hiring an editor." }))).toMatch(/too thin to be an ad/i);
  });

  it("rejects visual direction too thin to brief an image from", () => {
    expect(draftProblem(good({ visual_direction: "A desk." }))).toMatch(/too thin to brief/i);
  });

  it("rejects copy that will not fit the placement, and says by how much", () => {
    const problem = draftProblem(good({ hook: "x".repeat(81) }));
    expect(problem).toMatch(/81 characters/);
    expect(problem).toMatch(/Meta static allows 80/);
  });

  it("accepts a rich visual direction, which is a brief and not ad copy", () => {
    // The first version capped all six fields at ad-copy lengths and refused
    // real drafts for it: the generator wrote 653 and 853 character visual
    // directions and both were rejected for exceeding a Meta limit belonging
    // to a placement they are never part of.
    expect(draftProblem(good({ visual_direction: "A quiet editing desk. ".repeat(40) }))).toBeNull();
    expect(draftProblem(good({ premise: "x".repeat(600) }))).toBeNull();
    expect(draftProblem(good({ title: "x".repeat(200) }))).toBeNull();
  });

  it("still guards against a runaway, without blaming Meta for it", () => {
    const problem = draftProblem(good({ visual_direction: "x".repeat(2001) }));
    expect(problem).toMatch(/2001 characters/);
    expect(problem).toMatch(/keep it under 2000/);
    // Saying "Meta allows" here would send somebody looking at the wrong thing.
    expect(problem).not.toMatch(/Meta/);
  });
});

// The same failure that once put a fabricated phone number on a real
// practice's advertising: output that looks finished and is false.
describe("things a model must never put in a hiring ad", () => {
  it("rejects a bracketed placeholder", () => {
    expect(draftProblem(good({ hook: "Editor wanted [day rate]" }))).toMatch(/placeholder/i);
    expect(draftProblem(good({ title: "Editor — {{location}}" }))).toMatch(/placeholder/i);
  });

  it("rejects an invented link, because Apply URL is a person's job", () => {
    expect(draftProblem(good({ call_to_action: "Apply at attractacq.com/jobs" }))).toMatch(/link/i);
    expect(
      draftProblem(good({ script: good().script + " Apply at https://example.com/apply" })),
    ).toMatch(/link/i);
  });

  it("rejects an invented phone number", () => {
    expect(draftProblem(good({ script: good().script + " Call 031 566 4120." }))).toMatch(/phone number/i);
  });

  it("allows a screen or a feed in the visual direction", () => {
    // Visual direction describes a picture, not ad copy — a phone showing a
    // practice feed is exactly the kind of brief we want.
    expect(
      draftProblem(good({ visual_direction: "A phone in a calm hand showing a practice feed at www.example-practice.co.za, window light." })),
    ).toBeNull();
  });
});

describe("normaliseDraft", () => {
  it("returns only the fields the form takes", () => {
    const out = normaliseDraft({ ...good(), apply_url: "https://evil.example", compensation_text: "R900/day", extra: 1 });
    expect(Object.keys(out).sort()).toEqual([...DRAFT_FIELDS].sort());
  });

  it("does not carry an apply URL or compensation, which are the operator's", () => {
    // A model that invents either produces an ad that looks finished and is
    // false — a real person applies through that link, and AA pays that rate.
    const out = normaliseDraft({ ...good(), apply_url: "https://evil.example", compensation_text: "R900/day" });
    expect(JSON.stringify(out)).not.toContain("evil.example");
    expect(JSON.stringify(out)).not.toContain("R900");
  });

  it("trims, and turns anything that is not a string into an empty field", () => {
    const out = normaliseDraft({ ...good(), title: "  Editor  ", premise: 42 });
    expect(out.title).toBe("Editor");
    expect(out.premise).toBe("");
  });
});
