import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { masterProjectRender } from "./master.js";
import { probeProjectRender } from "./probe.js";

describe("project MP4 loudness master", () => {
  it("measures and corrects real audio while retaining the video stream", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aa-video-master-"));
    const sourcePath = join(directory, "source.mp4");
    const outputPath = join(directory, "master.mp4");
    try {
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f",
        "lavfi", "-i", "color=c=white:s=320x180:r=30", "-f", "lavfi",
        "-i", "sine=frequency=440:sample_rate=48000", "-t", "2",
        "-c:v", "libx264", "-c:a", "aac", "-shortest", "-y", sourcePath]);
      const master = await masterProjectRender({ sourcePath, outputPath });
      expect(master.fileBytes).toBeGreaterThan(100);
      const probe = await probeProjectRender({ path: outputPath, aspect: "16:9" });
      expect(probe.width).toBe(320);
      expect(probe.height).toBe(180);
      expect(probe.has_audio).toBe(true);
      expect(probe.audio_integrated_lufs).toBeGreaterThanOrEqual(-15.5);
      expect(probe.audio_integrated_lufs).toBeLessThanOrEqual(-12.5);
      expect(probe.audio_true_peak_dbfs).toBeLessThanOrEqual(-1.5);
      expect(probe.checks).toEqual(expect.arrayContaining([
        expect.stringContaining("Expected 1920x1080"),
        expect.stringContaining("20–960 seconds"),
      ]));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
