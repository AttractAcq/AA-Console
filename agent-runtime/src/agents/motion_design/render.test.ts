import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { motionFrame, motionPalette, renderMotion, validateMotionPlan } from "./render.js";

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
