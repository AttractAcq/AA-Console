import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "./compile.js";
import { validateIR } from "./schema.js";

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../fixtures/ir/gold-v2.json"), "utf8"));
const timings = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../fixtures/timings/gold-v2.json"), "utf8"));

describe("video IR", () => {
  it("accepts a hand-written nine-scene plan and compiles a serializable two-minute timeline", () => {
    expect(validateIR(fixture).ok).toBe(true);
    const timeline = compile(fixture, timings);
    expect(timeline.totalFrames).toBe(3600);
    expect(timeline.scenes).toHaveLength(9);
    expect(timeline.scenes[0]).toMatchObject({ id: "s01", startFrame: 0, durationInFrames: 416 });
    expect(timeline.scenes[1]).toMatchObject({ id: "s02", startFrame: 398, durationInFrames: 416 });
    expect(timeline.scenes.at(-1)?.startFrame).toBe(3184);
    expect(timeline.chapters).toEqual([
      { title: "Start with the market", startSec: 398 / 30 },
      { title: "ProcessDiagram", startSec: 1990 / 30 },
    ]);
    expect(JSON.parse(JSON.stringify(timeline))).toEqual(timeline);
    expect(compile(fixture, timings)).toEqual(timeline);
  });

  it("reports exact paths for invalid component props and rejects structural hazards", () => {
    const badProps = structuredClone(fixture);
    badProps.scenes[2].props = { heading: "Broken" };
    const result = validateIR(badProps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.some((problem) => problem.startsWith("scenes.2.props."))).toBe(true);

    const duplicateId = structuredClone(fixture);
    duplicateId.scenes[1].id = "s01";
    expect(validateIR(duplicateId).ok).toBe(false);
    const hex = structuredClone(fixture);
    hex.scenes[0].props.title = "Secret #ff00ff";
    expect(validateIR(hex).ok).toBe(false);
    const still = structuredClone(fixture);
    still.scenes[3].component = "ThumbnailCard";
    still.scenes[3].props = { hook: "Still" };
    expect(validateIR(still).ok).toBe(false);
  });

  it("binds timings by scene ID and refuses out-of-range audio or words", () => {
    const wrongId = structuredClone(timings);
    wrongId.scenes[1].id = "s09";
    expect(() => compile(fixture, wrongId)).toThrow("must refer to s02");
    const tooLong = structuredClone(timings);
    tooLong.scenes[0].durationSec = 24.9;
    expect(() => compile(fixture, tooLong)).toThrow("exceeds 25 seconds");
    const lateWord = structuredClone(timings);
    lateWord.scenes[0].words = [{ text: "Late", startSec: 13.4, endSec: 14 }];
    expect(() => compile(fixture, lateWord)).toThrow("word timing exceeds audio duration");
    const music = structuredClone(fixture);
    music.music.enabled = true;
    expect(() => compile(music, timings)).toThrow("Enabled music requires a source");
  });

  it("uses aligned phrases and falls back to a deterministic reveal when absent", () => {
    const aligned = structuredClone(timings);
    aligned.scenes[2].words = [
      { text: "A", startSec: 0, endSec: 0.2 },
      { text: "clear", startSec: 0.3, endSec: 0.5 },
      { text: "buying", startSec: 0.6, endSec: 0.8 },
      { text: "trigger", startSec: 0.9, endSec: 1.2 },
    ];
    const reveal = compile(fixture, aligned).scenes[2]?.props.revealAt;
    expect(reveal).toEqual([0, 13.46 * 0.65 / 3, 13.46 * 0.65 * 2 / 3]);

    const kinetic = structuredClone(fixture);
    kinetic.scenes[2].component = "KineticHeadline";
    kinetic.scenes[2].props = { words: ["real", "buying", "moment"] };
    kinetic.scenes[2].narration = "A real buying moment.";
    aligned.scenes[2].words = [
      { text: "A", startSec: 0, endSec: 0.2 },
      { text: "real", startSec: 0.3, endSec: 0.5 },
      { text: "buying", startSec: 0.6, endSec: 0.8 },
      { text: "moment.", startSec: 0.9, endSec: 1.2 },
    ];
    expect(compile(kinetic, aligned).scenes[2]?.props.revealAt).toEqual([0.3, 0.6, 0.9]);
  });
});
