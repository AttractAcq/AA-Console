import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { applyCriticPatch } from "./critic-patch.js";

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname,
  "../../../../video-render/fixtures/ir/three-scene-v2.json"), "utf8"));
const copy = () => structuredClone(fixture);

describe("pre-render critic patch gate", () => {
  it("applies two existing-prop edits without mutating the source", () => {
    const source = copy();
    const result = applyCriticPatch(source, [
      { op: "shorten_text", sceneId: "s01", path: "props.subtitle", value: "One problem" },
      { op: "set_prop", sceneId: "s02", path: "props.items.0", value: "Current demand" },
    ]);
    expect(result.changedSceneIds).toEqual(["s01", "s02"]);
    expect(result.nextStage).toBe("rendering");
    expect(result.ir.scenes[0]?.props).toMatchObject({ subtitle: "One problem" });
    expect(source.scenes[0].props.subtitle).toBe("One clear problem");
  });

  it("routes a narration edit back to timing", () => {
    const result = applyCriticPatch(copy(), [
      { op: "set_prop", sceneId: "s02", path: "narration",
        value: "Check the current evidence before choosing the offer." },
    ]);
    expect(result.narrationChanged).toBe(true);
    expect(result.nextStage).toBe("timing");
  });

  it("refuses locked scenes and does not allow component changes", () => {
    const source = copy();
    source.scenes[1].locked = true;
    expect(() => applyCriticPatch(source, [
      { op: "set_prop", sceneId: "s02", path: "props.heading", value: "New heading" },
    ])).toThrow(/locked/);
    expect(() => applyCriticPatch(copy(), [
      { op: "set_prop", sceneId: "s02", path: "component", value: "Quote" },
    ])).toThrow(/path/);
  });

  it("rejects prototype paths and invalid renderer output", () => {
    expect(() => applyCriticPatch(copy(), [
      { op: "set_prop", sceneId: "s02", path: "props.__proto__.polluted", value: true },
    ])).toThrow(/path/);
    expect(() => applyCriticPatch(copy(), [
      { op: "set_prop", sceneId: "s01", path: "props.title", value: 42 },
    ])).toThrow(/Invalid video IR/);
  });

  it("only increases a minimum duration and obeys opening transition rules", () => {
    const result = applyCriticPatch(copy(), [
      { op: "set_min_duration", sceneId: "s02", value: 5 },
      { op: "set_transition", sceneId: "s02", value: "slideUp" },
    ]);
    expect(result.ir.scenes[1]).toMatchObject({ minDurationSec: 5,
      transitionIn: "slideUp" });
    expect(() => applyCriticPatch(copy(), [
      { op: "set_transition", sceneId: "s01", value: "fade" },
    ])).toThrow(/Invalid video IR/);
  });
});
