import { describe, expect, it } from "vitest";
import { registry, validateComponentProps } from "./registry.js";
import { AspectSchema, DIMENSIONS, SAFE_AREAS } from "../components/primitives/Stage.js";

describe("video component catalogue", () => {
  it("validates every Studio fixture", () => {
    for (const [name, entry] of Object.entries(registry)) {
      const fixture = name === "TitleCard"
        ? { title: "Build a clearer route to growth", subtitle: "A simple operating system for service businesses", kicker: "ATTRACT ACQUISITION" }
        : name === "SectionCard"
          ? { index: 1, title: "Find the buying moment" }
          : { headline: "Ready to turn insight into action?", cta: "Explore the next step", url: "attractacq.com" };
      expect(entry.schema.parse(fixture)).toEqual(fixture);
      expect(entry.catalogueText.length).toBeGreaterThan(30);
      for (const aspect of AspectSchema.options) {
        const region = entry.textRegion(aspect);
        expect(region.x + region.width).toBeLessThanOrEqual(1);
        expect(region.y + region.height).toBeLessThanOrEqual(1);
      }
    }
  });

  it("rejects oversized and unsupported props before a render", () => {
    expect(() => validateComponentProps("TitleCard", { title: "x".repeat(61) })).toThrow();
    expect(() => validateComponentProps("SectionCard", { index: 10, title: "Invalid" })).toThrow();
    expect(() => validateComponentProps("Outro", { headline: "Done", cta: "Act", unreviewedUrl: "x" })).toThrow();
  });

  it("fixes a 30 fps layout for all three aspects", () => {
    expect(DIMENSIONS).toEqual({
      "16:9": { width: 1920, height: 1080 },
      "9:16": { width: 1080, height: 1920 },
      "1:1": { width: 1080, height: 1080 },
    });
    for (const aspect of AspectSchema.options) {
      expect(SAFE_AREAS[aspect].x).toBeGreaterThan(0);
      expect(SAFE_AREAS[aspect].y).toBeGreaterThan(0);
    }
  });
});
