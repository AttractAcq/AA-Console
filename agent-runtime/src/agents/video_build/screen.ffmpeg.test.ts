import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { coveredFraction } from "../../media/ffmpegLog.js";
import { DEAD_CLIP_COVERAGE, generatedClipProblem, probeGeneratedClip } from "./screen.js";

/**
 * The screen against real video, not against a hand-written probe.
 *
 * screen.test.ts pins the judgement; this pins the measurement. Between them
 * sits the thing neither can check alone: whether ffmpeg's detectors actually
 * fire on the clips this is meant to catch. A judgement that is correct about
 * numbers no detector ever produces would pass every unit test and catch
 * nothing in production.
 *
 * ffmpeg is installed in the agent-runtime image (see agent-runtime/Dockerfile)
 * for video_edit's render, so it is available wherever video_build runs.
 */
const run = promisify(execFile);
let dir: string;

const clip = (name: string) => join(dir, `${name}.mp4`);

async function generate(name: string, source: string) {
  await run("ffmpeg", [
    "-loglevel", "error", "-f", "lavfi", "-i", source,
    "-pix_fmt", "yuv420p", clip(name), "-y",
  ], { timeout: 60_000 });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "aa-screen-ffmpeg-"));
  await Promise.all([
    // Nothing rendered at all.
    generate("black", "color=c=black:s=320x568:d=5:r=24"),
    // A flat frame held for five seconds: what a model returns when it does
    // not animate the still it was given.
    generate("still", "color=c=slategray:s=320x568:d=5:r=24"),
    // Moving content, which must survive the screen untouched.
    generate("moving", "testsrc=s=320x568:d=5:r=24"),
    // A shot that fades up from black, which is a legitimate choice and the
    // case video_edit's probe would reject.
    generate("fade", "testsrc=s=320x568:d=5:r=24,fade=t=in:st=0:d=1"),
  ]);
}, 120_000);

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("measuring real clips", () => {
  it("refuses a clip that rendered nothing", async () => {
    const probe = await probeGeneratedClip(clip("black"));
    expect(probe.has_video_stream).toBe(true);
    expect(probe.black_intervals.length).toBeGreaterThan(0);
    expect(generatedClipProblem(probe)).toMatch(/black for the whole/);
  });

  it("refuses a still the model never animated", async () => {
    // The real-world shape of this case: freezedetect reports freeze_start
    // with NO freeze_end, because the freeze is still going when the file
    // ends. The parser closes it with the duration -- if it did not, an
    // entirely frozen clip would measure as no freeze at all and sail through.
    const probe = await probeGeneratedClip(clip("still"));
    expect(probe.freeze_intervals).toHaveLength(1);
    expect(probe.freeze_intervals[0]!.start_sec).toBe(0);
    expect(generatedClipProblem(probe)).toMatch(/returned a still image rather than a shot/);
  });

  it("passes moving content", async () => {
    const probe = await probeGeneratedClip(clip("moving"));
    expect(probe.duration_sec).toBeGreaterThan(4);
    expect(generatedClipProblem(probe)).toBeNull();
  });

  it("passes a shot that fades up from black", async () => {
    // video_edit fails ANY black interval; this must not, or the screen would
    // reject good work and people would learn to route around it.
    const probe = await probeGeneratedClip(clip("fade"));
    expect(generatedClipProblem(probe)).toBeNull();
  });

  it("reads dimensions and duration off the file", async () => {
    const probe = await probeGeneratedClip(clip("moving"));
    expect(probe.width).toBe(320);
    expect(probe.height).toBe(568);
  });
});

describe("why the threshold is not 1.0", () => {
  it("measures a wholly black clip at just under the whole", async () => {
    // blackdetect reports whole runs and the last frames fall outside one, so
    // a clip that is black end to end measures about 0.99 rather than 1.0.
    // A threshold of 1.0 would catch none of these. This is the empirical
    // reason for DEAD_CLIP_COVERAGE, rather than a number chosen by feel.
    const probe = await probeGeneratedClip(clip("black"));
    const covered = coveredFraction(probe.black_intervals, probe.duration_sec);
    expect(covered).toBeLessThan(1);
    expect(covered).toBeGreaterThanOrEqual(DEAD_CLIP_COVERAGE);
  });
});
