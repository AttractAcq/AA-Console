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
