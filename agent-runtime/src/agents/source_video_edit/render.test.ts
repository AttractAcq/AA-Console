import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "../video_edit/media.js";
import type { Edl } from "../video_edit/edl.js";
import { buildSourceRenderPlan } from "./render.js";

const edl: Edl = {
  segments: [
    { shot: 1, in_sec: 0.2, out_sec: 1.1, transition: "cut" },
    { shot: 1, in_sec: 1.3, out_sec: 2, transition: "cut" },
  ],
  captions: [], end_card_text: "", end_card_sec: 0, notes: "Tight cut",
};

function ffmpegAvailable(): boolean {
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

describe("supplied-footage render", () => {
  it("maps source audio through every selected video span", () => {
    const plan = buildSourceRenderPlan(edl, { sourcePath: "/in.mp4", outputPath: "/out.mp4",
      workDir: "/tmp", fontFile: "/font.ttf", aspect: "vertical", hasAudio: true });
    const graph = plan.args[plan.args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[v0][a0][v1][a1]concat=n=2:v=1:a=1[joined][audio]");
    expect(plan.args).toContain("[audio]");
    expect(plan.durationSec).toBeCloseTo(1.6);
  });

  it.skipIf(!ffmpegAvailable())("renders a trimmed cut with an audio stream", async () => {
    const dir = await mkdtemp(join(tmpdir(), "source-edit-test-"));
    try {
      const source = join(dir, "source.mp4");
      const output = join(dir, "cut.mp4");
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=2.2",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2.2",
        "-c:v", "libx264", "-c:a", "aac", "-shortest", source], { timeout: 30_000 });
      await render(buildSourceRenderPlan(edl, { sourcePath: source, outputPath: output,
        workDir: dir, fontFile: "/font.ttf", aspect: "square", hasAudio: true }));
      const streams = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams",
        "-of", "json", output], { encoding: "utf8" })) as { streams: Array<{ codec_type: string }> };
      expect(streams.streams.map((stream) => stream.codec_type).sort()).toEqual(["audio", "video"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 60_000);
});
