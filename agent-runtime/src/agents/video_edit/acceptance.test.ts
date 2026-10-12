import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import { probeRenderedVideo } from "./acceptance.js";

const run = promisify(execFile);

it("rejects an actual exported file with black frames", async () => {
  const work = await mkdtemp(join(tmpdir(), "video-acceptance-test-"));
  try {
    const path = join(work, "black.mp4");
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
      "-i", "color=c=black:s=1080x1920:r=15:d=3",
      "-c:v", "mpeg4", "-q:v", "8", path,
    ], { timeout: 30_000 });
    const probe = await probeRenderedVideo(path);
    expect(probe.result).toBe("fail");
    expect(probe.width).toBe(1080);
    expect(probe.height).toBe(1920);
    expect(probe.black_intervals.length).toBeGreaterThan(0);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}, 60_000);
