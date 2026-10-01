import { describe, expect, it } from "vitest";
import { briefSubmitTool, composeBody, framePlanColumns } from "./fields.js";
import { ZOOM_IN_MOTION_ID } from "../video_build/motions.js";
import {
  MOTION_PRESET_PLACEHOLDER,
  parseStoredShotPlan,
  reelBriefProblem,
  reelPlannerNote,
  serializeShot,
} from "./shots.js";

const shot = (
  beat: string,
  extra: Record<string, unknown> = {},
) => ({
  beat,
  duration_sec: 3,
  shot_source_kind: "ai_generated",
  motion_preset: MOTION_PRESET_PLACEHOLDER,
  ...extra,
});

const reelSubmission = (extra: Record<string, unknown> = {}) => ({
  format_code: "F6",
  frames: [shot("Name the mechanism"), shot("Show the step", { duration_sec: 4 })],
  ...extra,
});

describe("a reel brief", () => {
  it("is only briefed when the idea is video", () => {
    expect(reelBriefProblem("reel", "video")).toBeNull();
    expect(reelBriefProblem("carousel", "image")).toBeNull();
    expect(reelBriefProblem("reel", "image")).toMatch(/reel is a video/i);
  });

  it("tells the planner the phase 1 formats and not to invent a motion id", () => {
    const note = reelPlannerNote();
    expect(note).toContain("F6");
    expect(note).toContain("F7");
    expect(note).toContain("ai_generated");
    expect(note).toContain(MOTION_PRESET_PLACEHOLDER);
    expect(note).toContain(ZOOM_IN_MOTION_ID);
    expect(note).toMatch(/do not invent a motion uuid/i);
  });

  it("asks for a shot plan and a format code, and leaves a carousel on string frames", () => {
    const reel = briefSubmitTool("video", [], "reel");
    expect(reel.inputSchema.required).toEqual(expect.arrayContaining(["frames", "format_code"]));
    const frames = reel.inputSchema.properties.frames as unknown as {
      items: { properties: { shot_source_kind: { enum: string[] } } };
    };
    expect(frames.items.properties.shot_source_kind.enum).toEqual(["ai_generated"]);

    const carousel = briefSubmitTool("image", [], "carousel");
    const carouselFrames = carousel.inputSchema.properties.frames as { items: { type: string } };
    expect(carouselFrames.items.type).toBe("string");
    expect(carousel.inputSchema.properties).not.toHaveProperty("format_code");
    expect(carousel.inputSchema.required).not.toContain("format_code");
  });

  it("stores a shot-shaped frame plan for F6 and F7", () => {
    for (const format_code of ["F6", "F7"]) {
      const out = framePlanColumns(reelSubmission({ format_code }), "reel");
      expect(out.problem).toBeNull();
      expect(out.columns.format_code).toBe(format_code);
      expect(out.columns.frame_count).toBe(2);
      const lines = out.columns.frame_plan as string[];
      expect(JSON.parse(lines[0] ?? "")).toEqual({
        beat: "Name the mechanism",
        duration_sec: 3,
        motion_preset: ZOOM_IN_MOTION_ID,
        shot_source_kind: "ai_generated",
      });
      expect(parseStoredShotPlan(lines).shots).toHaveLength(2);
    }
  });

  it("leaves a carousel plan as plain lines", () => {
    const out = framePlanColumns({ frames: ["hook", "proof"] }, "carousel");
    expect(out.problem).toBeNull();
    expect(out.columns).toEqual({ frame_plan: ["hook", "proof"], frame_count: 2 });
  });

  it("refuses a client-asset shot", () => {
    const out = framePlanColumns(
      reelSubmission({
        format_code: "F7",
        frames: [shot("Open on the problem", { shot_source_kind: "source_asset" }), shot("Name the cost")],
      }),
      "reel",
    );
    expect(out.problem).toMatch(/ai_generated/);
    expect(out.columns).toEqual({});
  });

  it("refuses a reel with no duration and a format outside phase 1", () => {
    expect(
      framePlanColumns(
        reelSubmission({ frames: [shot("One", { duration_sec: 0 }), shot("Two")] }),
        "reel",
      ).problem,
    ).toMatch(/duration/i);
    expect(framePlanColumns(reelSubmission({ format_code: "F5" }), "reel").problem).toMatch(/F6/);
  });

  it("reads the stored plan back and refuses a plain carousel line", () => {
    const stored = framePlanColumns(reelSubmission(), "reel").columns.frame_plan as string[];
    expect(parseStoredShotPlan(stored).problem).toBeNull();
    expect(parseStoredShotPlan(["hook", "proof"]).problem).toMatch(/not a shot record/);
    expect(parseStoredShotPlan(null).problem).toMatch(/no shot plan/);
  });

  it("puts the shots in the readable brief without dumping the json", () => {
    const body = composeBody("video", {
      hook: "Stop the scroll",
      premise: "The mechanism",
      ...reelSubmission(),
    }, "reel");
    expect(body).toContain("## Shots");
    expect(body).toContain(`1. Name the mechanism (3s, generated, motion Zoom In ${ZOOM_IN_MOTION_ID})`);
    expect(body).not.toContain("motion pending");
    expect(body).not.toContain("shot_source_kind");
  });

  it("round-trips a shot through the stored line", () => {
    const line = serializeShot({
      beat: "Cold open",
      duration_sec: 2.5,
      shot_source_kind: "ai_generated",
      motion_preset: "pending",
    });
    expect(parseStoredShotPlan([line, serializeShot({
      beat: "Payoff",
      duration_sec: 4,
      shot_source_kind: "ai_generated",
      motion_preset: "pending",
    })]).shots[0]).toMatchObject({
      beat: "Cold open",
      duration_sec: 2.5,
      motion_preset: ZOOM_IN_MOTION_ID,
    });
  });

  it("stores Zoom In as the catalog id and leaves any other preset unresolved", () => {
    const named = framePlanColumns(
      reelSubmission({
        frames: [shot("Open", { motion_preset: "Zoom In" }), shot("Hold", { motion_preset: "zoom_in" })],
      }),
      "reel",
    );
    const lines = named.columns.frame_plan as string[];
    expect(JSON.parse(lines[0] ?? "").motion_preset).toBe(ZOOM_IN_MOTION_ID);
    expect(JSON.parse(lines[1] ?? "").motion_preset).toBe(ZOOM_IN_MOTION_ID);

    const other = framePlanColumns(
      reelSubmission({
        frames: [
          shot("Pan", { motion_preset: "Pan Left" }),
          shot("Other", { motion_preset: "11111111-1111-4111-8111-111111111111" }),
        ],
      }),
      "reel",
    );
    const kept = other.columns.frame_plan as string[];
    expect(JSON.parse(kept[0] ?? "").motion_preset).toBe("Pan Left");
    expect(JSON.parse(kept[1] ?? "").motion_preset).toBe("11111111-1111-4111-8111-111111111111");
  });
});
