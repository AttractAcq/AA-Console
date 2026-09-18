import { describe, expect, it } from "vitest";
import { unsupportedStrictKeywords, missingStrictRequired } from "../../tools/schema.js";
import { IMAGE_CONCEPT_TOOL, TEXT_CONCEPT_TOOL } from "./index.js";
import { conceptProblem, recruitmentConceptProblem, TREATMENTS } from "./concept.js";

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

// OpenAI 400 after PR #51 on every image rebuild:
//   Invalid schema for response_format 'submit_concept' ... Missing 'background'.
// background and visual_treatment were added to properties; required was not.
// Strict json_schema demands every property appear in required.
describe("the submit_concept schema OpenAI actually receives", () => {
  const schema = IMAGE_CONCEPT_TOOL.inputSchema;

  it("is named submit_concept, which is the name in the production 400", () => {
    expect(IMAGE_CONCEPT_TOOL.name).toBe("submit_concept");
  });

  it("uses only what a strict schema may contain", () => {
    expect(unsupportedStrictKeywords(schema)).toEqual([]);
    expect(missingStrictRequired(schema)).toEqual([]);
  });

  it("requires every property it offers, including background and visual_treatment", () => {
    const props = Object.keys(schema.properties);
    for (const name of props) expect(schema.required).toContain(name);
    expect(schema.required).toContain("background");
    expect(schema.required).toContain("visual_treatment");
  });

  it("still asks for a real background and a non-typography treatment", () => {
    // The fix must not have been to delete the fields PR #51 added.
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.background?.type).toBe("string");
    expect(props.visual_treatment?.enum).toEqual([...TREATMENTS]);
    expect(props.visual_treatment?.enum).not.toContain("typographic");
    expect(props.visual_treatment?.enum).not.toContain("typography");
  });

  it("refuses fields it did not ask for", () => {
    expect(schema.additionalProperties).toBe(false);
  });
});

describe("the text route schema", () => {
  it("is untouched — still submit_copy, still no imagery fields", () => {
    expect(TEXT_CONCEPT_TOOL.name).toBe("submit_copy");
    const schema = TEXT_CONCEPT_TOOL.inputSchema;
    const props = Object.keys(schema.properties);
    expect(props).not.toContain("background");
    expect(props).not.toContain("visual_treatment");
    expect(props).not.toContain("subject");
    expect(schema.required).toEqual(["headline", "body", "call_to_action", "rationale"]);
    expect(unsupportedStrictKeywords(schema)).toEqual([]);
    expect(missingStrictRequired(schema)).toEqual([]);
  });
});

// The first three hiring ads AA generated read as advertising for AA's
// services. "Six practices. Six voices. Not yours." is a good line and, on a
// dental practice's feed, it sells social media management. Nothing on any of
// them said the agency was hiring — because creative_build was never told it
// was making a job ad.
describe("a recruitment ad has to say a job is open", () => {
  const ad = (over: Record<string, unknown> = {}) => ({
    headline: "We're hiring an editor",
    subhead: "48 hours. Durban hours.",
    call_to_action: "Apply now",
    ...over,
  });

  it("accepts an ad that plainly says it", () => {
    expect(recruitmentConceptProblem(ad(), "editor")).toBeNull();
  });

  it("rejects the ad that actually shipped", () => {
    const problem = recruitmentConceptProblem(
      { headline: "Six practices. Six voices. Not yours.", subhead: "Calendar and approvals. Not community management.", call_to_action: "Apply now" },
      "smm",
    );
    expect(problem).toMatch(/nothing on this ad says anybody is hiring/i);
  });

  it("rejects the editor ad that actually shipped", () => {
    expect(
      recruitmentConceptProblem(
        { headline: "Your cut should look like the clinic", subhead: "48 hours. Durban hours.", call_to_action: "Apply with your reel" },
        "editor",
      ),
    ).toMatch(/nothing on this ad says anybody is hiring/i);
  });

  it("does not accept a call to action as the signal", () => {
    // "Apply now" is on every ad AA runs. It is the button, not the news.
    expect(
      recruitmentConceptProblem({ headline: "A real face, over 35.", subhead: "", call_to_action: "Apply now" }, "avatar"),
    ).toMatch(/nothing on this ad says anybody is hiring/i);
  });

  it("takes the signal from the subhead as well as the headline", () => {
    expect(
      recruitmentConceptProblem(
        { headline: "Your cut should look like the clinic", subhead: "We're hiring an editor. 48 hours.", call_to_action: "Apply now" },
        "editor",
      ),
    ).toBeNull();
  });

  it("insists the role is named, in words an applicant would recognise", () => {
    const problem = recruitmentConceptProblem(
      { headline: "We're hiring", subhead: "Durban hours, remote.", call_to_action: "Apply now" },
      "smm",
    );
    expect(problem).toMatch(/never names the role/i);
    expect(problem).toContain("social media manager");
  });

  it("accepts the ways each role actually gets named", () => {
    expect(recruitmentConceptProblem(ad({ headline: "Now hiring: SMM" }), "smm")).toBeNull();
    expect(recruitmentConceptProblem(ad({ headline: "We're hiring a social media manager" }), "smm")).toBeNull();
    expect(recruitmentConceptProblem(ad({ headline: "Hiring: on-camera, over 35" }), "avatar")).toBeNull();
  });

  it("rejects an ad with no words at all", () => {
    expect(recruitmentConceptProblem({ headline: "", subhead: "", call_to_action: "" }, "editor")).toMatch(
      /carries no text/i,
    );
  });
});
