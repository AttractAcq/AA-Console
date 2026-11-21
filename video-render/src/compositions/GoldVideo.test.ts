import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GOLD_FIXTURE } from "./gold-fixture.generated.js";
import { goldDuration, validateGoldFixture } from "./GoldVideo.js";

const source = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../fixtures/ir/gold-01.json"), "utf8"));

describe("two-minute gold fixture", () => {
  it("renders the hand-written JSON source without generated drift", () => {
    expect(GOLD_FIXTURE).toEqual(source);
    const fixture = validateGoldFixture(source);
    expect(fixture.scenes).toHaveLength(9);
    expect(goldDuration(fixture)).toBe(3600);
    expect(fixture.scenes[0]?.component).toBe("TitleCard");
    expect(fixture.scenes.at(-1)?.component).toBe("Outro");
  });

  it("holds invalid component props, sequence and timing before rendering", () => {
    expect(() => validateGoldFixture({ scenes: source.scenes.map((scene: object, index: number) => index === 3 ? { ...scene, props: { invalid: true } } : scene) })).toThrow();
    expect(() => validateGoldFixture({ scenes: source.scenes.map((scene: object, index: number) => index === 4 ? { ...scene, durationInFrames: 400 } : scene) })).toThrow("exactly two minutes");
    expect(() => validateGoldFixture({ scenes: source.scenes.map((scene: object, index: number) => index === 8 ? { ...scene, component: "Quote" } : scene) })).toThrow("end with Outro");
  });
});
