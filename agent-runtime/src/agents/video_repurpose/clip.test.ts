import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hasAudioStream } from "../source_video_edit/transcript.js";
import { probeDurationSec } from "../video_edit/media.js";
import { extractRepurposeClip } from "./clip.js";

it("extracts an eight-second source span with audible track intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "repurpose-clip-test-"));
  try {
    const source = join(dir, "source.mp4");
    const output = join(dir, "clip.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=10",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=10",
      "-c:v", "libx264", "-c:a", "aac", "-shortest", source], { timeout: 30_000 });
    await extractRepurposeClip(source, output, 1, 9);
    expect(await hasAudioStream(output)).toBe(true);
    expect(await probeDurationSec(output)).toBeGreaterThan(7.8);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 60_000);
