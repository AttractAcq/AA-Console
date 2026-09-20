import { describe, expect, it } from "vitest";
import { clampToSentence, draftProblem, normaliseDraft, DRAFT_FIELDS, META_CTAS } from "./draft.js";

const good = (over: Record<string, unknown> = {}) => ({
  title: "Editor — vertical cutdowns for dental practices",
  hook: "Cut the work that actually ships",
  script:
    "Attract Acquisition is hiring an editor for vertical cutdowns. You take an approved brief and turn it into a still that looks like the practice it belongs to. Durban hours, start in January.",
  call_to_action: "APPLY_NOW",
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
    expect(draftProblem(good({ visual_direction: "A quiet editing desk. ".repeat(40) }))).toBeNull();
    expect(draftProblem(good({ premise: "x".repeat(600) }))).toBeNull();
    expect(draftProblem(good({ title: "x".repeat(200) }))).toBeNull();
  });

  // Smoke testing all three roles threw away three of five generations for
  // overshooting an internal cap by a handful of characters: a visual
  // direction at 2029 against 2000, a premise at 617 against 600. Every one of
  // those drafts was good, and each rejection cost a fresh model call.
  it("does not throw away a whole draft over an internal field running long", () => {
    expect(draftProblem(good({ visual_direction: "A quiet desk. ".repeat(200) }))).toBeNull();
    expect(draftProblem(good({ premise: "x".repeat(617) }))).toBeNull();
    expect(draftProblem(good({ title: "x".repeat(900) }))).toBeNull();
  });

  it("still refuses something pathological", () => {
    expect(draftProblem(good({ premise: "x".repeat(20_001) }))).toMatch(/implausibly long/i);
  });

});

describe("clamping the internal fields", () => {
  it("trims a long visual direction to the last whole sentence", () => {
    const value = "A quiet desk in daylight. A monitor at three-quarters. A brand card by the mug.";
    expect(clampToSentence(value, 30)).toBe("A quiet desk in daylight.");
    expect(clampToSentence(value, 60)).toBe("A quiet desk in daylight. A monitor at three-quarters.");
  });

  it("does not clamp to a fragment when the only sentence break is very early", () => {
    // "Yes. " followed by four hundred words of direction should not become
    // the word "Yes."
    const value = "Yes. " + "a detailed description without punctuation ".repeat(10);
    const out = clampToSentence(value, 200);
    expect(out).not.toBe("Yes.");
    expect(out.length).toBeGreaterThan(100);
  });

  it("falls back to a word boundary rather than cutting mid-word", () => {
    // An image brief ending "...palette restrained and institu" is worse than
    // one sentence shorter.
    const out = clampToSentence("palette restrained and institutional throughout", 20);
    expect(out).toBe("palette restrained");
    expect(out).not.toMatch(/institu$/);
  });

  it("leaves anything already short enough exactly alone", () => {
    expect(clampToSentence("Short enough.", 500)).toBe("Short enough.");
  });

  it("clamps through normaliseDraft, so the real 2029 case now lands", () => {
    const out = normaliseDraft(good({ visual_direction: "A quiet desk in daylight. ".repeat(100) }));
    expect(out.visual_direction.length).toBeLessThanOrEqual(2000);
    expect(out.visual_direction.endsWith(".")).toBe(true);
  });

  it("never clamps the Meta copy, which must fail loudly instead", () => {
    // Silently trimming a headline would ship a half-sentence to a placement.
    const out = normaliseDraft(good({ hook: "x".repeat(200) }));
    expect(out.hook).toHaveLength(200);
    expect(draftProblem(good({ hook: "x".repeat(200) }))).toMatch(/Meta static allows 80/);
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
    expect(draftProblem(good({ hook: "Apply at attractacq.com/jobs" }))).toMatch(/link/i);
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


// The generator was writing prose — "Apply with three cutdowns", "Apply to run
// the calendar". Good copy, and unusable: the CTA on a Meta static is a button
// from a fixed list, so whoever built the ad would have had to pick a real one
// and discard the words.
describe("the call to action is a Meta button, not a sentence", () => {
  it("accepts every button Meta offers for a link ad", () => {
    for (const cta of META_CTAS) {
      expect(draftProblem(good({ call_to_action: cta })), cta).toBeNull();
    }
  });

  // The list is a subset of Meta's full set now rather than its own literal,
  // so widening the shared list must not quietly widen this one. A hiring ad
  // points at an apply URL: SEND_MESSAGE has no thread to open and the
  // commerce buttons have nothing to sell.
  it("offers exactly the four a hiring ad can use", () => {
    expect([...META_CTAS]).toEqual(["APPLY_NOW", "LEARN_MORE", "SIGN_UP", "CONTACT_US"]);
  });

  it("rejects the buttons that need a destination a hiring ad does not have", () => {
    for (const cta of ["SEND_MESSAGE", "SHOP_NOW", "BOOK_NOW", "GET_OFFER", "GET_QUOTE", "DOWNLOAD", "SUBSCRIBE"]) {
      expect(draftProblem(good({ call_to_action: cta })), cta).toMatch(/not a Meta call-to-action button/i);
    }
  });

  it("rejects the prose the generator actually produced, and lists the real options", () => {
    const problem = draftProblem(good({ call_to_action: "Apply with three cutdowns" }));
    expect(problem).toMatch(/not a Meta call-to-action button/i);
    expect(problem).toContain("APPLY_NOW");
  });

  it("rejects a label that merely looks right", () => {
    // "Apply now" is the label; APPLY_NOW is the value Meta takes.
    expect(draftProblem(good({ call_to_action: "Apply now" }))).toMatch(/not a Meta call-to-action/i);
    expect(draftProblem(good({ call_to_action: "apply_now" }))).toMatch(/not a Meta call-to-action/i);
  });

  it("still requires one at all", () => {
    expect(draftProblem(good({ call_to_action: "" }))).toMatch(/no call to action/i);
  });
});
