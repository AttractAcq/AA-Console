import { describe, expect, it } from "vitest";
import { unsupportedStrictKeywords, UNSUPPORTED_STRICT_KEYWORDS } from "./schema.js";

describe("unsupportedStrictKeywords", () => {
  it("passes a schema built from the supported subset", () => {
    expect(
      unsupportedStrictKeywords({
        type: "object",
        properties: {
          name: { type: "string", description: "A name." },
          kind: { type: "string", enum: ["a", "b"] },
          items: { type: "array", items: { type: "string" } },
        },
        required: ["name"],
        additionalProperties: false,
      }),
    ).toEqual([]);
  });

  it("finds the exact keyword that took the Campaign Planner down", () => {
    // Anthropic 400: tools.0.custom: For 'array' type, property 'maxItems' is
    // not supported. Every run of the agent failed on this one line.
    const found = unsupportedStrictKeywords({
      type: "object",
      properties: {
        ideas: { type: "array", maxItems: 30, items: { type: "object" } },
      },
    });
    expect(found).toEqual(["properties.ideas.maxItems"]);
  });

  it("reaches keywords buried inside array items", () => {
    const found = unsupportedStrictKeywords({
      type: "object",
      properties: {
        ideas: {
          type: "array",
          items: {
            type: "object",
            properties: { title: { type: "string", maxLength: 300 } },
          },
        },
      },
    });
    expect(found).toEqual(["properties.ideas.items.properties.title.maxLength"]);
  });

  it("reports every occurrence, not just the first", () => {
    // The API reports one at a time, so fixing one and redeploying to discover
    // the next is exactly the loop this is meant to prevent.
    const found = unsupportedStrictKeywords({
      type: "object",
      properties: {
        a: { type: "array", maxItems: 3, items: { type: "string", minLength: 1 } },
        b: { type: "string", pattern: "^x" },
      },
    });
    expect(found).toHaveLength(3);
    expect(found).toContain("properties.a.maxItems");
    expect(found).toContain("properties.a.items.minLength");
    expect(found).toContain("properties.b.pattern");
  });

  it("does not mistake a property NAMED like a keyword for one", () => {
    // A campaign genuinely has a "format" and a "pattern"; those are fields the
    // model fills in, not constraints on the schema.
    expect(
      unsupportedStrictKeywords({
        type: "object",
        properties: {
          format: { type: "string", description: "Which format this is for." },
          pattern: { type: "string" },
          default: { type: "boolean" },
        },
      }),
    ).toEqual([]);
  });

  it("still catches a real keyword sitting beside such a property", () => {
    const found = unsupportedStrictKeywords({
      type: "object",
      properties: {
        format: { type: "string", maxLength: 40 },
      },
    });
    expect(found).toEqual(["properties.format.maxLength"]);
  });

  it("survives the shapes a schema can actually contain", () => {
    expect(unsupportedStrictKeywords(null)).toEqual([]);
    expect(unsupportedStrictKeywords(undefined)).toEqual([]);
    expect(unsupportedStrictKeywords("string")).toEqual([]);
    expect(unsupportedStrictKeywords({ anyOf: [{ type: "string", minLength: 2 }] })).toEqual([
      "anyOf[0].minLength",
    ]);
  });

  it("covers the constraint families the strict subset drops", () => {
    for (const keyword of UNSUPPORTED_STRICT_KEYWORDS) {
      const found = unsupportedStrictKeywords({ type: "object", [keyword]: 1 });
      expect(found, `${keyword} should be reported`).toEqual([keyword]);
    }
  });
});
