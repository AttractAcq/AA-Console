import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateRuntimeIR } from "./validate.js";

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname,
  "../../../video-render/fixtures/ir/three-scene-v2.json"), "utf8"));
const copy = () => structuredClone(fixture);

describe("runtime video IR gate", () => {
  it("accepts a renderer-owned three-scene IR", () => {
    expect(validateRuntimeIR(copy())).toMatchObject({ ok: true });
  });
  it("accepts an omitted cut transition that renderer Zod defaults", () => {
    const ir = copy();
    delete ir.scenes[0].transitionIn;
    expect(validateRuntimeIR(ir)).toMatchObject({ ok: true });
  });
  it("rejects component props through the renderer JSON Schema", () => {
    const ir = copy();
    ir.scenes[0].props = { title: 42 };
    expect(validateRuntimeIR(ir)).toMatchObject({ ok: false });
  });
  it("rejects duplicate aspects, wrong scene IDs and repeated components", () => {
    const ir = copy();
    ir.aspects = ["16:9", "16:9"];
    ir.scenes[1].id = "s09";
    ir.scenes[1].component = "TitleCard";
    ir.scenes[1].props = { title: "Another title" };
    const result = validateRuntimeIR(ir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toMatch(/duplicate aspect|expected s02|consecutive/);
  });
  it("rejects prose and reveal alignment that the renderer rejects", () => {
    const ir = copy();
    ir.scenes[1].props.items[0] = "One two three four five six seven eight";
    ir.scenes[1].props.revealAt = [0];
    const result = validateRuntimeIR(ir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toMatch(/seven words|one reveal time per item/);
  });
  it("rejects component refinements omitted by JSON Schema export", () => {
    const ir = copy();
    ir.scenes[1].component = "Chart";
    ir.scenes[1].props = {
      kind: "pie", categories: ["A", "B"],
      series: [{ name: "first", values: [1] }, { name: "second", values: [2] }],
    };
    const result = validateRuntimeIR(ir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toMatch(/one value per category|pie chart needs one series/);
  });
});
