import { describe, expect, it } from "vitest";
import {
  CONTENT_FORMATS,
  coerceFormat,
  formatFitsMedia,
  formatsForMedia,
  isContentFormat,
  isMultiFrame,
} from "./format.js";

describe("formatFitsMedia", () => {
  it("keeps a carousel to images", () => {
    expect(formatFitsMedia("carousel", "image")).toBe(true);
    expect(formatFitsMedia("carousel", "video")).toBe(false);
    expect(formatFitsMedia("carousel", "text")).toBe(false);
  });

  it("lets a story be a still or a clip", () => {
    expect(formatFitsMedia("story", "image")).toBe(true);
    expect(formatFitsMedia("story", "video")).toBe(true);
    expect(formatFitsMedia("story", "text")).toBe(false);
  });

  it("lets single carry anything, text included", () => {
    for (const media of ["image", "text", "video"]) {
      expect(formatFitsMedia("single", media)).toBe(true);
    }
  });

  it("refuses a format it does not know", () => {
    expect(formatFitsMedia("reel", "video")).toBe(false);
  });
});

describe("coerceFormat", () => {
  it("keeps a pairing that holds", () => {
    expect(coerceFormat("carousel", "image")).toBe("carousel");
    expect(coerceFormat("story", "video")).toBe("story");
  });

  // The batch insert is one statement: one contradictory idea would take the
  // other twenty-four down with it.
  it("falls back to single rather than losing the idea", () => {
    expect(coerceFormat("carousel", "video")).toBe("single");
    expect(coerceFormat("story", "text")).toBe("single");
  });

  it("falls back to single for anything it does not recognise", () => {
    expect(coerceFormat("reel", "video")).toBe("single");
    expect(coerceFormat(undefined, "image")).toBe("single");
    expect(coerceFormat(7, "image")).toBe("single");
  });

  // Whatever comes back must be storable, or the constraint added in 112
  // rejects the insert.
  it("always returns a pairing the database will accept", () => {
    for (const media of ["image", "text", "video"]) {
      for (const candidate of [...CONTENT_FORMATS, "reel", "", null]) {
        expect(formatFitsMedia(coerceFormat(candidate, media), media)).toBe(true);
      }
    }
  });
});

describe("formatsForMedia", () => {
  it("offers text one shape only", () => {
    expect(formatsForMedia("text")).toEqual(["single"]);
  });

  it("offers an image all three", () => {
    expect(formatsForMedia("image")).toEqual(["single", "carousel", "story"]);
  });

  it("offers video single and story", () => {
    expect(formatsForMedia("video")).toEqual(["single", "story"]);
  });
});

describe("isMultiFrame", () => {
  it("is the two formats made of frames", () => {
    expect(isMultiFrame("carousel")).toBe(true);
    expect(isMultiFrame("story")).toBe(true);
    expect(isMultiFrame("single")).toBe(false);
  });
});

describe("isContentFormat", () => {
  it("accepts the three and nothing else", () => {
    expect(isContentFormat("single")).toBe(true);
    expect(isContentFormat("carousel")).toBe(true);
    expect(isContentFormat("story")).toBe(true);
    expect(isContentFormat("reel")).toBe(false);
    expect(isContentFormat(null)).toBe(false);
  });
});
