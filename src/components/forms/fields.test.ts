import { describe, expect, it } from "vitest";
import { initialsFrom, isVisible, slugFrom, titleFromFile } from "./fields";
import type { FieldDef, FormValues } from "./fields";

describe("initialsFrom", () => {
  it("takes the first letter of the first two words", () => {
    expect(initialsFrom("Attract Acquisition")).toBe("AA");
  });

  it("uppercases lowercase input", () => {
    expect(initialsFrom("jane doe")).toBe("JD");
  });

  it("handles a single word", () => {
    expect(initialsFrom("Cher")).toBe("C");
  });

  it("collapses repeated whitespace and ignores more than two words", () => {
    expect(initialsFrom("  Ada   Lovelace Byron ")).toBe("AL");
  });

  it("returns an empty string for empty input", () => {
    expect(initialsFrom("")).toBe("");
  });
});

describe("slugFrom", () => {
  it("lowercases and joins words with underscores", () => {
    expect(slugFrom("Brand Strategist")).toBe("brand_strategist");
  });

  it("strips non-alphanumeric characters", () => {
    expect(slugFrom("Money Model (v2)!")).toBe("money_model_v2");
  });

  it("trims leading and trailing underscores", () => {
    expect(slugFrom("  -- Ideation --  ")).toBe("ideation");
  });
});

describe("titleFromFile", () => {
  it("strips the extension from a filename", () => {
    const file = new File(["x"], "brand-photo.png", { type: "image/png" });
    expect(titleFromFile(file)).toBe("brand-photo");
  });

  it("returns an empty string for null", () => {
    expect(titleFromFile(null)).toBe("");
  });
});

describe("isVisible", () => {
  const base: FieldDef = { name: "extra", label: "Extra", kind: "text" };

  it("is always visible without a showIf", () => {
    expect(isVisible(base, {})).toBe(true);
  });

  it("is visible when the watched field matches", () => {
    const field: FieldDef = { ...base, showIf: { field: "kind", equals: ["contractor"] } };
    const values: FormValues = { kind: "contractor" };
    expect(isVisible(field, values)).toBe(true);
  });

  it("is hidden when the watched field does not match", () => {
    const field: FieldDef = { ...base, showIf: { field: "kind", equals: ["contractor"] } };
    const values: FormValues = { kind: "employee" };
    expect(isVisible(field, values)).toBe(false);
  });

  it("is hidden when the watched field is missing or not a string", () => {
    const field: FieldDef = { ...base, showIf: { field: "kind", equals: ["contractor"] } };
    expect(isVisible(field, {})).toBe(false);
    expect(isVisible(field, { kind: true })).toBe(false);
  });
});
