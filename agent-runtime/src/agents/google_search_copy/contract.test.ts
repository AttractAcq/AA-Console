import { describe, expect, it } from "vitest";

import { parseGoogleSearchCopy } from "./contract.js";

const valid = () => ({
  headlines: ["Book a Home Survey", "Local Garage Conversion", "See Your Options Today"],
  descriptions: ["Discuss your project with our team.", "Book a consultation to explore the next step."],
  rationale: "The copy invites the local buyer to discuss the signed offer without inventing results.",
});

describe("reviewable Google search copy", () => {
  it("keeps the exact bounded text for a human decision", () => {
    expect(parseGoogleSearchCopy(valid())).toEqual(valid());
  });

  it("refuses missing, repeated, oversized and extra copy", () => {
    expect(() => parseGoogleSearchCopy({ ...valid(), headlines: ["One", "Two"] })).toThrow();
    expect(() => parseGoogleSearchCopy({ ...valid(), headlines: ["One", "one", "Three"] })).toThrow();
    expect(() => parseGoogleSearchCopy({ ...valid(), headlines: ["A".repeat(31), "Two", "Three"] })).toThrow();
    expect(() => parseGoogleSearchCopy({ ...valid(), descriptions: ["One".repeat(91), "Two"] })).toThrow();
    expect(() => parseGoogleSearchCopy({ ...valid(), approved: true })).toThrow(/unexpected fields/);
  });

  it("refuses empty and multiline entries rather than silently producing a misleading bundle", () => {
    expect(() => parseGoogleSearchCopy({ ...valid(), headlines: ["One", "  ", "Three"] })).toThrow();
    expect(() => parseGoogleSearchCopy({ ...valid(), descriptions: ["Line one\nLine two", "Two"] })).toThrow();
  });
});
