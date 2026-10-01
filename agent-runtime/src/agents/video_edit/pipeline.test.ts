/**
 * The whole chain, from the rows video_build leaves behind to a file.
 *
 * Stand-in clips, because Higgsfield is not reachable from a test: ffmpeg
 * generates three clips of the lengths a shot plan asks for, and every step
 * after that is the real code — the stored shot plan is parsed by the brief
 * agent's own parser, readiness is decided from frame rows in the shape
 * PostgREST returns, durations are probed from the files, and the EDL is
 * validated and rendered.
 *
 * What this proves is the handoff: that the columns video_build writes are
 * enough to edit from. What it cannot prove is that a model writes a good
 * cut, which needs real clips and a real key.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MOTION_PRESET_PLACEHOLDER, serializeShot } from "../brief/shots.js";
import { parseEdl, validateEdl, type Edl } from "./edl.js";
import { editContext, editReadiness, type BriefForEdit, type FrameRowForEdit } from "./handoff.js";
import { probeDurationSec, render } from "./media.js";
import { buildRenderPlan } from "./render.js";

const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const SHOTS = [
  { beat: "Cold open on an empty gym floor", seconds: 4 },
  { beat: "Name the mechanism: the 3 step check-in", seconds: 4 },
  { beat: "Payoff: the floor is full", seconds: 3 },
];

const brief: BriefForEdit = {
  id: "brief-1",
  title: "Why gyms lose members by March",
  media_type: "video",
  content_format: "reel",
  format_code: "F6",
  frame_plan: SHOTS.map((shot) =>
    serializeShot({
      beat: shot.beat,
      duration_sec: shot.seconds,
      shot_source_kind: "ai_generated",
      motion_preset: MOTION_PRESET_PLACEHOLDER,
    }),
  ),
  hook: "Most gyms lose 30% of members by March.",
  script: "Shot 1: the empty floor. Shot 2: the 3 step check-in. Shot 3: the full floor.",
  call_to_action: "Book a call.",
  proof: null,
  channel_intent: "Instagram Reels",
};

describe.skipIf(!hasFfmpeg() || !existsSync(FONT))("video_build to video_edit, end to end", () => {
  let dir = "";
  let frames: FrameRowForEdit[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "video-edit-e2e-"));
    // Stands in for what persistCompletedClip copies out of Higgsfield:
    // one 9:16 clip per shot, at the planned length.
    frames = SHOTS.map((shot, index) => {
      const position = index + 1;
      const path = join(dir, `clip-${position}.mp4`);
      execFileSync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", `testsrc2=s=608x1080:r=24:d=${shot.seconds}`,
        "-pix_fmt", "yuv420p", path,
      ]);
      return {
        id: `frame-${position}`,
        position,
        beat: shot.beat,
        // PostgREST returns numeric as a string.
        duration_sec: String(shot.seconds),
        shot_source_kind: "ai_generated",
        clip_path: path,
        provider_job_id: `hf-request-${position}`,
      };
    });
  }, 60_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("will not edit while a clip is missing, then will once it lands", () => {
    const waiting = frames.map((frame, i) => (i === 1 ? { ...frame, clip_path: null } : frame));
    expect(editReadiness(brief, waiting)).toMatchObject({ ready: false, reason: "clips_missing" });
    expect(editReadiness(brief, frames).ready).toBe(true);
  });

  it("cuts a reel from the rows video_build leaves behind", async () => {
    const readiness = editReadiness(brief, frames);
    if (!readiness.ready) throw new Error(readiness.message);

    const probed = new Map<number, number>();
    for (const shot of readiness.shots) probed.set(shot.shot, await probeDurationSec(shot.clipPath));
    expect([...probed.values()]).toEqual([4, 4, 3].map((n) => expect.closeTo(n, 1)));

    const context = editContext({
      shots: readiness.shots,
      probedDurations: probed,
      brief,
      neverDo: "Never say guaranteed",
    });
    expect(context.max_total_sec).toBe(11);

    // Stands in for the model's answer, through the same parser a tool call goes through.
    const planned = parseEdl({
      segments: [
        { shot: 1, in_sec: 0.5, out_sec: 3.5, transition: "cut" },
        { shot: 2, in_sec: 0.2, out_sec: 3.2, transition: "crossfade" },
        { shot: 3, in_sec: 0, out_sec: 2.5, transition: "cut" },
      ],
      captions: [
        { text: "Most gyms lose 30% of members", start_sec: 0.3, end_sec: 3, position: "middle" },
        { text: "A 3 step check-in", start_sec: 3.4, end_sec: 6.5, position: "bottom" },
      ],
      end_card_text: "Book a call",
      end_card_sec: 2,
      notes: "Opens on the empty floor, pays off on the full one.",
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    expect(validateEdl(planned.edl, context)).toEqual([]);

    const output = join(dir, "reel.mp4");
    const plan = buildRenderPlan(planned.edl, {
      clipPaths: new Map(readiness.shots.map((shot) => [shot.shot, shot.clipPath])),
      outputPath: output,
      fontFile: FONT,
      workDir: dir,
    });
    await render(plan);

    expect(await probeDurationSec(output)).toBeCloseTo(plan.durationSec, 1);
    const size = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", output,
    ]).toString().trim();
    expect(size).toBe("1080,1920");
  }, 120_000);

  it("refuses a cut that claims something the brief does not say", () => {
    const readiness = editReadiness(brief, frames);
    if (!readiness.ready) throw new Error(readiness.message);
    const context = editContext({ shots: readiness.shots, probedDurations: new Map(), brief, neverDo: "guaranteed" });
    const edl: Edl = {
      segments: [{ shot: 1, in_sec: 0, out_sec: 3, transition: "cut" }],
      captions: [{ text: "Guaranteed 80% retention", start_sec: 0, end_sec: 2.5, position: "middle" }],
      end_card_text: "",
      end_card_sec: 0,
      notes: "",
    };
    expect(validateEdl(edl, context)).toEqual([
      'Caption 1 says "80", which is not in the brief.',
      'Caption 1 uses "guaranteed", which the brand bans.',
    ]);
  });
});
