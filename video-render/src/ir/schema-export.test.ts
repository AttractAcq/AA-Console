import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const schema = JSON.parse(readFileSync(resolve(root, "generated/ir.schema.json"), "utf8"));
const gold = JSON.parse(readFileSync(resolve(root, "fixtures/ir/gold-v2.json"), "utf8"));
const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);

describe("exported video IR JSON Schema", () => {
  it("accepts the hand-written video fixture", () => {
    expect(validate(gold)).toBe(true);
  });

  it("rejects invalid component props and still-only components", () => {
    const missingItems = structuredClone(gold);
    missingItems.scenes[2].props = { heading: "Broken" };
    expect(validate(missingItems)).toBe(false);

    const still = structuredClone(gold);
    still.scenes[3].component = "ThumbnailCard";
    still.scenes[3].props = { hook: "Not a video scene" };
    expect(validate(still)).toBe(false);
  });

  it("rejects extra fields in the strict envelope", () => {
    const extra = { ...gold, undeclared: true };
    expect(validate(extra)).toBe(false);
  });
});
