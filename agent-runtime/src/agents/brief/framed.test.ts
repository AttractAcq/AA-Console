import { describe, expect, it } from "vitest";
import {
  briefColumns,
  briefSubmitTool,
  composeBody,
  fieldsFor,
  framePlanColumns,
  framePlanFrom,
} from "./fields.js";

const filled = (extra: Record<string, unknown> = {}) => ({
  title: "Five reasons",
  hook: "Stop overpaying",
  premise: "You are paying twice",
  argument: "Because...",
  proof: "",
  script: "Frame 1: ... Frame 2: ...",
  visual_direction: "Warm, documentary",
  call_to_action: "Book a call",
  channel_intent: "Instagram",
  production_notes: "",
  ...extra,
});

describe("fieldsFor with a format", () => {
  it("is unchanged for a single, which is every brief written so far", () => {
    expect(fieldsFor("image")).toEqual(fieldsFor("image", "single"));
  });

  // A carousel briefed as "the on-image copy for a still" is one block of
  // words for five separate images.
  it("stops calling the script one block of copy for a carousel", () => {
    const single = new Map(fieldsFor("image", "single"));
    const carousel = new Map(fieldsFor("image", "carousel"));
    expect(single.get("script")).toContain("on-image copy for a still");
    expect(carousel.get("script")).not.toContain("on-image copy for a still");
    expect(carousel.get("script")).toContain("in order, marked by frame");
  });

  it("tells a framed hook its job is to earn the swipe", () => {
    expect(new Map(fieldsFor("image", "story")).get("hook")).toContain("earn the swipe");
  });

  it("leaves the fields whose meaning does not change alone", () => {
    const single = new Map(fieldsFor("image", "single"));
    const carousel = new Map(fieldsFor("image", "carousel"));
    for (const field of ["premise", "proof", "production_notes", "channel_intent"]) {
      expect(carousel.get(field)).toBe(single.get(field));
    }
  });

  it("still drops the video-only fields for a framed image", () => {
    const names = fieldsFor("image", "carousel").map(([n]) => n);
    expect(names).not.toContain("shot_requirements");
    expect(names).not.toContain("b_roll");
  });
});

describe("briefSubmitTool", () => {
  it("asks a single brief for no frame plan at all", () => {
    const tool = briefSubmitTool("image", [], "single");
    expect(tool.inputSchema.properties.frames).toBeUndefined();
    expect(tool.inputSchema.required).not.toContain("frames");
  });

  it("requires a frame plan of a carousel", () => {
    const tool = briefSubmitTool("image", [], "carousel");
    expect(tool.inputSchema.properties.frames).toBeDefined();
    expect(tool.inputSchema.required).toContain("frames");
  });

  // A strict schema rejects maxItems, which is why the bound is checked in
  // code — the same reason the campaign idea count is.
  it("states the bounds in words rather than as maxItems", () => {
    const frames = briefSubmitTool("image", [], "carousel").inputSchema.properties.frames as {
      description: string;
      maxItems?: number;
    };
    expect(frames.maxItems).toBeUndefined();
    expect(frames.description).toContain("2");
    expect(frames.description).toContain("10");
  });
});

describe("framePlanColumns", () => {
  it("writes nothing for a single, which migration 113 refuses frames on", () => {
    expect(framePlanColumns(filled({ frames: ["a", "b"] }), "single")).toEqual({
      columns: {},
      problem: null,
    });
  });

  it("stores the plan and derives the count from it", () => {
    const out = framePlanColumns(filled({ frames: ["hook", "objection", "proof"] }), "carousel");
    expect(out.problem).toBeNull();
    expect(out.columns).toEqual({ frame_plan: ["hook", "objection", "proof"], frame_count: 3 });
  });

  it("trims each line so the stored plan matches what is read back", () => {
    const out = framePlanColumns(filled({ frames: ["  hook  ", "proof "] }), "carousel");
    expect(out.columns.frame_plan).toEqual(["hook", "proof"]);
  });

  // The plan is the whole difference between a carousel brief and an image
  // brief. Filing it blank produces exactly the brief this exists to stop.
  it("refuses a framed brief with no usable plan rather than filing one without", () => {
    expect(framePlanColumns(filled({ frames: [] }), "carousel").problem).toContain("at least 2");
    expect(framePlanColumns(filled({}), "carousel").problem).toContain("at least 2");
    expect(framePlanColumns(filled({ frames: ["only"] }), "carousel").problem).toContain("at least 2");
  });

  it("refuses a plan past the limit", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `frame ${i}`);
    expect(framePlanColumns(filled({ frames: eleven }), "carousel").problem).toContain("10 frames is the limit");
  });

  // Refused rather than dropped: the model was asked for N frames and
  // returned one it had nothing to say about. Shrinking the set hides that.
  it("refuses a blank line rather than silently shrinking the set", () => {
    const out = framePlanColumns(filled({ frames: ["hook", "   ", "proof"] }), "carousel");
    expect(out.problem).toContain("Frame 2");
  });
});

describe("composeBody", () => {
  it("puts the sequence in the readable brief, numbered", () => {
    const body = composeBody("image", filled({ frames: ["hook", "the objection"] }), "carousel");
    expect(body).toContain("## Frames");
    expect(body).toContain("1. hook");
    expect(body).toContain("2. the objection");
  });

  it("adds no Frames section to a single", () => {
    expect(composeBody("image", filled({ frames: ["a", "b"] }), "single")).not.toContain("## Frames");
  });
});

describe("briefColumns", () => {
  it("never tries to write the plan as a text column", () => {
    expect(briefColumns("image", filled({ frames: ["a", "b"] }), "carousel").frames).toBeUndefined();
  });
});

describe("framePlanFrom", () => {
  it("is empty when the model returned nothing usable", () => {
    expect(framePlanFrom({})).toEqual([]);
    expect(framePlanFrom({ frames: "hook" })).toEqual([]);
  });

  it("blanks a non-string entry rather than dropping it, so the count is refused", () => {
    expect(framePlanFrom({ frames: ["hook", 7, "proof"] })).toEqual(["hook", "", "proof"]);
  });
});
