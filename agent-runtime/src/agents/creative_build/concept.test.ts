import { describe, expect, it } from "vitest";
import { conceptProblem, TREATMENTS } from "./concept.js";

const good = (over: Record<string, unknown> = {}) => ({
  headline: "CHEWING IS NOT A COSMETIC PROBLEM",
  subhead: "",
  call_to_action: "",
  subject: "A man in his sixties at a restaurant table, mid-laugh, eating on both sides.",
  background:
    "A warm Durban seafront restaurant in the early evening, other diners soft behind him, window light from the left.",
  visual_treatment: "photographic",
  composition: "Portrait crop, subject left of centre, type across the lower third.",
  art_direction: "Natural light, warm neutrals, no studio polish.",
  avoid: "No stock-photo smiles, no dental clinic interiors, no before-and-after.",
  rationale: "Shows the outcome rather than the procedure.",
  ...over,
});

describe("a concept that will produce an image", () => {
  it("accepts a real scene", () => {
    expect(conceptProblem(good())).toBeNull();
  });

  it("accepts every treatment the schema offers", () => {
    for (const treatment of TREATMENTS) {
      expect(conceptProblem(good({ visual_treatment: treatment })), treatment).toBeNull();
    }
  });

  it("does not trip on an avoid list that rules imagery out", () => {
    // `avoid` is supposed to say "no stock photos". Reading it as a
    // declaration of emptiness would reject the best-written concepts.
    expect(
      conceptProblem(good({ avoid: "No photography of clinics, no illustration, no people in scrubs." })),
    ).toBeNull();
  });
});

// The image route was producing text cards. Not because the renderer failed —
// it rendered faithfully — but because the concepts asked for them.
describe("a concept that would produce a text card", () => {
  it("rejects the one that actually shipped", () => {
    const problem = conceptProblem(
      good({
        subject:
          "A single one-page commercial scope document, built entirely from typography and hairline rules. The document contains no photography, people, devices, icons, charts, badges or logos.",
        background: "A #F5F7F3 paper ground with a #FFFFFF inset document and hairline rules.",
      }),
    );
    expect(problem).toMatch(/rules out imagery|text post/i);
  });

  it("rejects the other one that actually shipped", () => {
    const problem = conceptProblem(
      good({
        subject:
          "A single typeset qualification document with no photography, illustration, people or objects.",
      }),
    );
    expect(problem).toMatch(/rules out imagery|text post/i);
  });

  it("rejects a concept with no background at all", () => {
    expect(conceptProblem(good({ background: "" }))).toMatch(/no background|show something/i);
  });

  it("rejects a colour offered as a background", () => {
    // "A flat brand green" is how a text card describes itself.
    expect(conceptProblem(good({ background: "Flat #142B23." }))).toMatch(/too thin|setting or scene/i);
  });

  it("rejects a concept with nothing in frame", () => {
    expect(conceptProblem(good({ subject: "" }))).toMatch(/nothing in frame|no subject/i);
  });
});

describe("the treatment", () => {
  it("refuses a typography-only treatment, which is the whole point", () => {
    expect(conceptProblem(good({ visual_treatment: "typographic" }))).toMatch(/not a way of making an image/i);
  });

  it("refuses a missing treatment and says what the choices are", () => {
    const problem = conceptProblem(good({ visual_treatment: undefined }));
    expect(problem).toMatch(/not a way of making an image/i);
    expect(problem).toContain("photographic");
  });
});

describe("what the check does not do", () => {
  it("survives a concept that is not shaped like one", () => {
    expect(conceptProblem({})).toMatch(/no subject|nothing in frame/i);
    expect(conceptProblem({ subject: 42, background: null })).toMatch(/no subject|nothing in frame/i);
  });

  it("does not require text on the image", () => {
    // A picture with no words is a legitimate post; an empty frame is not.
    expect(conceptProblem(good({ headline: "", subhead: "", call_to_action: "" }))).toBeNull();
  });
});
