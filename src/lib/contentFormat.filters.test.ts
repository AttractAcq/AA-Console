import { describe, expect, it } from "vitest";
import { CONTENT_FORMATS, formatAllows, formatFilters, formatLabel } from "./contentFormat";

describe("formatFilters", () => {
  // Format is the second axis: an idea is an image AND a carousel. A pill row
  // that forced a choice would hide most of the bank the moment it rendered.
  it("leads with All so nothing is hidden by default", () => {
    expect(formatFilters[0]).toEqual({ id: "all", label: "All formats" });
  });

  it("offers every format exactly once", () => {
    const ids = formatFilters.slice(1).map((f) => f.id);
    expect(ids).toEqual(CONTENT_FORMATS.map((f) => f.value));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("labels each pill the way the table labels the row", () => {
    for (const filter of formatFilters.slice(1)) {
      expect(filter.label).toBe(formatLabel(filter.id));
    }
  });
});

describe("the pairings the manual idea form allows", () => {
  it("refuses a video carousel", () => {
    expect(formatAllows("carousel", "video")).toBe(false);
  });

  it("refuses a text story", () => {
    expect(formatAllows("story", "text")).toBe(false);
  });

  it("allows what the database will accept", () => {
    expect(formatAllows("carousel", "image")).toBe(true);
    expect(formatAllows("story", "image")).toBe(true);
    expect(formatAllows("story", "video")).toBe(true);
    for (const media of ["image", "text", "video"]) {
      expect(formatAllows("single", media)).toBe(true);
    }
  });
});
