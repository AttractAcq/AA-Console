import { describe, expect, it } from "vitest";
import {
  CONTENT_FORMATS,
  MAX_FRAMES,
  MIN_FRAMES,
  formatAllows,
  formatLabel,
  frameCountProblem,
  isMultiFrame,
  mediaTypesFor,
} from "./contentFormat";

describe("the formats", () => {
  it("holds the three that change how something is produced", () => {
    expect(CONTENT_FORMATS.map((f) => f.value)).toEqual(["single", "carousel", "story"]);
  });

  it("knows which are made of frames", () => {
    expect(isMultiFrame("carousel")).toBe(true);
    expect(isMultiFrame("story")).toBe(true);
    expect(isMultiFrame("single")).toBe(false);
    expect(isMultiFrame(null)).toBe(false);
    expect(isMultiFrame("reel")).toBe(false);
  });

  it("names them for a screen, and shows an unknown value rather than hiding it", () => {
    expect(formatLabel("carousel")).toBe("Carousel");
    expect(formatLabel("")).toBe("");
    expect(formatLabel("reel")).toBe("reel");
  });
});

describe("what a format can carry", () => {
  // The whole reason this is not another media_type value.
  it("lets a story be a still or a clip", () => {
    expect(mediaTypesFor("story")).toEqual(["image", "video"]);
    expect(formatAllows("story", "video")).toBe(true);
    expect(formatAllows("story", "image")).toBe(true);
  });

  it("keeps a carousel to images, because a set of clips is a story", () => {
    expect(mediaTypesFor("carousel")).toEqual(["image"]);
    expect(formatAllows("carousel", "video")).toBe(false);
  });

  it("has no frames for text, so text is single only", () => {
    expect(formatAllows("single", "text")).toBe(true);
    expect(formatAllows("carousel", "text")).toBe(false);
    expect(formatAllows("story", "text")).toBe(false);
  });

  it("refuses a format it does not know", () => {
    expect(formatAllows("reel", "video")).toBe(false);
  });
});

describe("frameCountProblem", () => {
  it("accepts a frame count a multi-frame format can actually run", () => {
    expect(frameCountProblem("carousel", MIN_FRAMES)).toBeNull();
    expect(frameCountProblem("carousel", 5)).toBeNull();
    expect(frameCountProblem("story", MAX_FRAMES)).toBeNull();
  });

  it("refuses too few, because that is two posts rather than a carousel", () => {
    expect(frameCountProblem("carousel", 1)).toContain(`at least ${MIN_FRAMES}`);
    expect(frameCountProblem("story", 0)).toContain(`at least ${MIN_FRAMES}`);
  });

  it("refuses more than anybody swipes through", () => {
    expect(frameCountProblem("carousel", MAX_FRAMES + 1)).toContain(`${MAX_FRAMES} frames is the limit`);
  });

  it("refuses frames on something that is not made of them", () => {
    expect(frameCountProblem("single", 3)).toContain("has no frames");
    expect(frameCountProblem("single", 0)).toBeNull();
  });
});
