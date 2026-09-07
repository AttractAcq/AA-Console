import { describe, expect, it } from "vitest";
import { briefSubmitTool, composeBody, briefColumns, fieldsFor } from "./fields.js";

const full = {
  title: "Spring whitening",
  hook: "Your teeth are fine. The photo is the problem.",
  premise: "Whitening is about photographs, not dentistry",
  argument: "Lead with the moment, then the method",
  proof: "Harbour has done 400 of these",
  script: "Line one. Line two.",
  visual_direction: "Warm, unstyled",
  shot_requirements: "Close on the smile, then the chair",
  b_roll: "Reception, hands, daylight",
  call_to_action: "Book a consultation",
  channel_intent: "Instagram reel",
  production_notes: "Shoot at the practice, weekday morning",
};

describe("which fields a brief has", () => {
  // A shot list on a still image is noise, not a gap. This is different from
  // brand or identity, where a blank is a real absence worth showing.
  it("drops the video-only fields for an image brief", () => {
    const names = fieldsFor("image").map(([n]) => n);
    expect(names).not.toContain("shot_requirements");
    expect(names).not.toContain("b_roll");
    expect(names).toContain("hook");
  });

  it("keeps them for video", () => {
    const names = fieldsFor("video").map(([n]) => n);
    expect(names).toContain("shot_requirements");
    expect(names).toContain("b_roll");
  });

  it("treats text like image", () => {
    expect(fieldsFor("text").map(([n]) => n)).not.toContain("b_roll");
  });
});

describe("the submit tool", () => {
  // Required, so the model states an absence rather than omitting the key —
  // the discipline identity and brand already follow.
  it("requires every field it offers, so silence is not an option", () => {
    const tool = briefSubmitTool("video");
    const props = Object.keys(tool.inputSchema.properties);
    for (const name of props) expect(tool.inputSchema.required).toContain(name);
  });

  it("asks a video brief for shots and an image brief not to", () => {
    expect(briefSubmitTool("video").inputSchema.required).toContain("shot_requirements");
    expect(briefSubmitTool("image").inputSchema.required).not.toContain("shot_requirements");
  });

  it("refuses fields it did not ask for", () => {
    expect(briefSubmitTool("image").inputSchema.additionalProperties).toBe(false);
  });
});

describe("the readable body", () => {
  // Composed, not written separately: two outputs would be free to disagree.
  it("is built from the fields, in order, with headings", () => {
    const body = composeBody("video", full);
    expect(body).toContain("## Hook\n\nYour teeth are fine. The photo is the problem.");
    expect(body.indexOf("## Hook")).toBeLessThan(body.indexOf("## Premise"));
    expect(body).toContain("## B-roll");
  });

  it("leaves out a heading for a field the model left empty", () => {
    const body = composeBody("image", { ...full, proof: "" });
    expect(body).not.toContain("## Proof");
    expect(body).toContain("## Hook");
  });

  it("carries production notes into the prose", () => {
    expect(composeBody("image", full)).toContain("Shoot at the practice");
  });

  it("omits video sections from an image brief even when the model sends them", () => {
    const body = composeBody("image", full);
    expect(body).not.toContain("## Shot requirements");
    expect(body).not.toContain("## B-roll");
  });
});

describe("what gets stored as columns", () => {
  it("stores each field", () => {
    const cols = briefColumns("video", full);
    expect(cols.hook).toBe("Your teeth are fine. The photo is the problem.");
    expect(cols.call_to_action).toBe("Book a consultation");
    expect(cols.b_roll).toBe("Reception, hands, daylight");
  });

  // production_notes lives in the prose only — it is for a person, and giving
  // it a column would imply something reads it.
  it("does not give production notes a column", () => {
    expect(briefColumns("video", full)).not.toHaveProperty("production_notes");
  });

  it("writes an unanswered field as null rather than an empty string", () => {
    expect(briefColumns("image", { ...full, proof: "   " }).proof).toBeNull();
  });

  it("stores no video columns for an image brief", () => {
    const cols = briefColumns("image", full);
    expect(cols).not.toHaveProperty("shot_requirements");
    expect(cols).not.toHaveProperty("b_roll");
  });
});

describe("the proof reference the brief may cite", () => {
  // The guard that matters. A free-text field would let a model cite proof
  // that does not exist, which is an invented phone number one step earlier.
  it("constrains the choice to the records actually offered", () => {
    const tool = briefSubmitTool("image", ["HD-0019", "HD-0020"]);
    const prop = tool.inputSchema.properties.proof_ref as { enum: string[] };
    expect(prop.enum).toEqual(["HD-0019", "HD-0020", ""]);
  });

  // Empty is a legitimate answer: this piece makes no proof claim.
  it("always allows an empty choice alongside the real ones", () => {
    const prop = briefSubmitTool("image", ["HD-0019"]).inputSchema.properties.proof_ref as {
      enum: string[];
    };
    expect(prop.enum).toContain("");
  });

  it("is required, so the model states a decision rather than omitting it", () => {
    expect(briefSubmitTool("image", ["HD-0019"]).inputSchema.required).toContain("proof_ref");
  });

  // With nothing cleared there is nothing to choose from, and an enum of one
  // empty string would be a strange thing to ask a model to answer.
  it("is absent entirely when no proof was offered", () => {
    const tool = briefSubmitTool("image", []);
    expect(tool.inputSchema.properties).not.toHaveProperty("proof_ref");
    expect(tool.inputSchema.required).not.toContain("proof_ref");
  });

  it("ignores blank references rather than offering them as a choice", () => {
    const tool = briefSubmitTool("image", ["", "  ", "HD-0019"]);
    const prop = tool.inputSchema.properties.proof_ref as { enum: string[] };
    expect(prop.enum).toEqual(["HD-0019", ""]);
  });

  // It is a link, not prose — composing it into the body would put a bare
  // reference in front of a maker who has no way to look it up.
  it("never appears as a section of the readable brief", () => {
    const body = composeBody("image", { hook: "h", premise: "p", proof_ref: "HD-0019" });
    expect(body).not.toContain("HD-0019");
    expect(body).not.toMatch(/proof_ref/i);
  });

  it("is not stored as a brief column, since it resolves to a foreign key", () => {
    expect(briefColumns("image", { proof_ref: "HD-0019" })).not.toHaveProperty("proof_ref");
  });
});
