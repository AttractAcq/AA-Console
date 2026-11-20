import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import copiedSchema from "./brand-overrides.schema.json" with { type: "json" };
import { videoBrandSnapshot } from "./brand-snapshot.js";

describe("exact project brand snapshot", () => {
  it("uses the renderer's current override contract", () => {
    const source = JSON.parse(readFileSync(resolve(import.meta.dirname,
      "../../../video-render/src/brand/overrides.schema.json"), "utf8"));
    expect(copiedSchema).toEqual(source);
  });

  it("accepts reviewed client colours and rejects malformed override tokens", () => {
    const snapshot = { colour_primary: "#123456",
      video_tokens: { colours: { accent: "#FEDCBA" } } };
    expect(videoBrandSnapshot(snapshot)).toBe(snapshot);
    expect(() => videoBrandSnapshot(null)).toThrow(/no exact brand/);
    expect(() => videoBrandSnapshot({ video_tokens: {
      colours: { accent: "not-a-colour" } } })).toThrow(/invalid/);
    expect(() => videoBrandSnapshot({ unwanted: "other client" }))
      .toThrow(/invalid/);
  });
});
