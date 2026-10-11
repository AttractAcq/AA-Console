import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, it } from "vitest";
import { applyPromptPalette, fitMotionPlan, motionFrame, motionPalette, renderMotion, validateMotionPlan } from "./render.js";

const scene = { duration_sec: 1, headline: "Explain <the> idea & grow", body: "A clear next step",
  motif: "orbit" as const, motion: "pulse" as const };

it("rejects unsupported motion plans and escapes prompt text", () => {
  expect(() => validateMotionPlan({ scenes: [{ ...scene, motion: "javascript" }] }, 1, "hero"))
    .toThrow(/unsupported/);
  expect(motionFrame(scene, 0, "horizontal", motionPalette({}), { width: 320, height: 180 }))
    .toContain("&lt;the&gt; idea &amp; grow");
});

it("renders a playable MP4 and poster from a one-scene loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "motion-render-test-"));
  try {
    const output = join(dir, "motion.mp4");
    const poster = join(dir, "poster.jpg");
    const plan = validateMotionPlan({ scenes: [scene] }, 1, "hero");
    const result = await renderMotion(plan, { aspect: "horizontal", palette: motionPalette({}),
      workDir: dir, outputPath: output, posterPath: poster,
      testSize: { width: 320, height: 180 } });
    expect(result.durationSec).toBe(1);
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams",
      "-of", "json", output], { encoding: "utf8" })) as { streams: Array<{ codec_type: string }> };
    expect(probe.streams.map((stream) => stream.codec_type)).toContain("video");
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 60_000);

it("keeps authored card placement and progressively draws a connection", () => {
  const plan = validateMotionPlan({ scenes: [{ duration_sec: 2, background: "background", elements: [
    { kind: "rect", x: 100, y: 140, width: 190, height: 120, radius: 12,
      color: "surface", at_sec: 0, enter: "fade" },
    { kind: "text", x: 125, y: 210, size: 36, text: "Idea & Proof", weight: 700,
      color: "primary", at_sec: 0, enter: "rise" },
    { kind: "line", x: 290, y: 200, x2: 600, y2: 200, stroke_width: 6,
      color: "accent", at_sec: .5, enter: "draw" },
  ] }] }, 2, "explainer");
  const before = motionFrame(plan.scenes[0]!, .1, "horizontal", motionPalette({}));
  const drawing = motionFrame(plan.scenes[0]!, .4, "horizontal", motionPalette({}));
  expect(before).toContain("Idea &amp; Proof");
  expect(before).not.toContain("stroke-dasharray");
  expect(drawing).toContain("stroke-dasharray");
  expect(drawing).toContain('x2="600"');
  expect(() => validateMotionPlan({ scenes: [{ duration_sec: 2, background: "url(http://bad)", elements: [] }] },
    2, "explainer")).toThrow(/background/);
});

it("moves a card from authored starting coordinates into place", () => {
  const plan = validateMotionPlan({ scenes: [{ duration_sec: 2, background: "background", elements: [
    { kind: "rect", x: 400, y: 200, from_x: 100, from_y: 80,
      width: 200, height: 100, color: "surface", at_sec: 0,
      enter: "move", enter_duration_sec: 1 },
  ] }] }, 2, "explainer");
  const start = motionFrame(plan.scenes[0]!, 0, "horizontal", motionPalette({}));
  const end = motionFrame(plan.scenes[0]!, .5, "horizontal", motionPalette({}));
  expect(start).toContain("translate(-300 -120)");
  expect(end).toContain("translate(0 0)");
  expect(() => validateMotionPlan({ scenes: [{ duration_sec: 2, background: "background", elements: [
    { kind: "rect", x: 400, y: 200, width: 200, height: 100,
      color: "surface", at_sec: 0, enter: "move" },
  ] }] }, 2, "explainer")).toThrow(/starting coordinates/);
});

it("rejects off-canvas cards and honours explicit named colours", () => {
  const brand = motionPalette({ background: "#F5F7F3", primary: "#142B23",
    accent: "#D8EDB4", text: "#192925" });
  const scene = { duration_sec: 2, background: "#F5F7F3", elements: [
    { kind: "rect" as const, x: 800, y: 200, width: 150, height: 120,
      color: "#FFFFFF", at_sec: 0, enter: "fade" as const },
    { kind: "text" as const, x: 100, y: 100, size: 32, text: "A chain",
      color: "#142B23", at_sec: 0, enter: "fade" as const },
  ] };
  expect(() => validateMotionPlan({ scenes: [{ ...scene, elements: [
    { ...scene.elements[0], x: 880 }, scene.elements[1],
  ] }] }, 2, "explainer")).toThrow(/fully within/);
  const plan = validateMotionPlan({ scenes: [scene] }, 2, "explainer");
  const directed = applyPromptPalette(plan, "Use warm off-white paper, deep navy and vivid blue.", brand);
  expect(directed.palette).toEqual({ background: "#F7F5EF", primary: "#14243A",
    accent: "#1A4FD6", text: "#14243A" });
  expect(directed.plan.scenes[0]).toMatchObject({ background: "#F7F5EF",
    elements: [{ color: "#FFFFFF" }, { color: "#14243A" }] });
});

it("fits an otherwise valid off-canvas card row after a failed model correction", () => {
  const raw = { scenes: [{ duration_sec: 2, background: "background", elements: [
    { kind: "rect", x: 0, y: 0, width: 1000, height: 8, color: "accent",
      at_sec: 0, enter: "none" },
    { kind: "rect", x: 880, y: 300, from_x: 880, from_y: 420,
      width: 150, height: 120, color: "surface", at_sec: 0, enter: "move" },
    { kind: "text", x: 900, y: 370, from_x: 900, from_y: 490,
      size: 24, text: "CAMPAIGN", color: "primary", at_sec: 0, enter: "move" },
  ] }] };
  const loose = validateMotionPlan(raw, 2, "explainer", "horizontal", true);
  const fitted = fitMotionPlan(loose, "horizontal");
  expect(() => validateMotionPlan(fitted, 2, "explainer", "horizontal")).not.toThrow();
  const scene = fitted.scenes[0]!;
  if (!("elements" in scene)) throw new Error("Expected designed scene.");
  expect(scene.elements[0]).toMatchObject({ x: 0, width: 1000 });
  expect(scene.elements[1]!.x! + scene.elements[1]!.width!).toBeLessThanOrEqual(1000);
  expect(scene.elements[1]!.from_y! - scene.elements[1]!.y!).toBeGreaterThan(0);
});

it("renders an authored multi-element scene as MP4", async () => {
  const dir = await mkdtemp(join(tmpdir(), "motion-designed-test-"));
  try {
    const plan = validateMotionPlan({ scenes: [{ duration_sec: 1, background: "background", elements: [
      { kind: "rect", x: 100, y: 100, width: 280, height: 160, radius: 16,
        color: "surface", at_sec: .2, enter: "scale" },
      { kind: "text", x: 125, y: 190, size: 48, text: "IDEA", color: "primary",
        at_sec: 0, enter: "rise" },
      { kind: "line", x: 380, y: 180, x2: 760, y2: 180, color: "accent",
        at_sec: .2, enter: "draw" },
    ] }] }, 1, "explainer");
    const result = await renderMotion(plan, { aspect: "horizontal", palette: motionPalette({}),
      workDir: dir, outputPath: join(dir, "motion.mp4"), posterPath: join(dir, "poster.jpg"),
      testSize: { width: 320, height: 180 } });
    expect(result.durationSec).toBe(1);
    const posterStats = await sharp(join(dir, "poster.jpg")).stats();
    expect(posterStats.channels[0]!.stdev).toBeGreaterThan(1);
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json",
      join(dir, "motion.mp4")], { encoding: "utf8" })) as { streams: Array<{ codec_type: string }> };
    expect(probe.streams.map((stream) => stream.codec_type)).toContain("video");
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 60_000);
