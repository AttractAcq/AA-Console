import { describe, expect, it } from "vitest";

import { MOTION_PRESET_PLACEHOLDER, serializeShot } from "../brief/shots.js";
import {
  bannedPhrases,
  briefTextForEdit,
  DEFAULT_MAX_REEL_SEC,
  editContext,
  editReadiness,
  maxReelSeconds,
  type BriefForEdit,
  type FrameRowForEdit,
} from "./handoff.js";

function planLine(beat: string, duration = 4): string {
  return serializeShot({
    beat,
    duration_sec: duration,
    shot_source_kind: "ai_generated",
    motion_preset: MOTION_PRESET_PLACEHOLDER,
  });
}

const brief: BriefForEdit = {
  id: "b1",
  title: "Why gyms lose members",
  media_type: "video",
  content_format: "reel",
  format_code: "F6",
  frame_plan: [planLine("Cold open"), planLine("Name the mechanism"), planLine("Payoff")],
  hook: "Most gyms lose 30% of members by March.",
  script: "Shot 1: the empty floor. Shot 2: the 3 step check-in. Shot 3: the full floor.",
  call_to_action: "Book a call.",
  proof: null,
  channel_intent: "Instagram Reels",
};

function frame(position: number, overrides: Partial<FrameRowForEdit> = {}): FrameRowForEdit {
  return {
    id: `f${position}`,
    position,
    beat: `Beat ${position}`,
    duration_sec: 4,
    shot_source_kind: "ai_generated",
    caption: null,
    clip_path: `client/generated/clips/f${position}.mp4`,
    provider_job_id: `req-${position}`,
    ...overrides,
  };
}

describe("editReadiness", () => {
  it("returns shots in position order once every clip is on file", () => {
    const result = editReadiness(brief, [frame(3), frame(1), frame(2)]);
    expect(result.ready).toBe(true);
    if (!result.ready) return;
    expect(result.shots.map((shot) => shot.shot)).toEqual([1, 2, 3]);
    expect(result.shots[0]).toMatchObject({
      frameId: "f1",
      beat: "Beat 1",
      plannedDurationSec: 4,
      clipPath: "client/generated/clips/f1.mp4",
    });
  });

  it("reads a numeric duration that PostgREST returned as a string", () => {
    const result = editReadiness(brief, [frame(1, { duration_sec: "3.75" }), frame(2), frame(3)]);
    expect(result.ready && result.shots[0]!.plannedDurationSec).toBe(3.75);
  });

  it("falls back to the plan when a frame carries no beat or source kind", () => {
    const result = editReadiness(brief, [
      frame(1, { beat: "  ", shot_source_kind: null, duration_sec: null }),
      frame(2),
      frame(3),
    ]);
    expect(result.ready && result.shots[0]).toMatchObject({
      beat: "Cold open",
      shotSourceKind: "ai_generated",
      plannedDurationSec: 4,
    });
  });

  it("separates a shot still waiting on Higgsfield from one never submitted", () => {
    const result = editReadiness(brief, [
      frame(1),
      frame(2, { clip_path: null }),
      frame(3, { clip_path: "  ", provider_job_id: null }),
    ]);
    expect(result).toEqual({
      ready: false,
      reason: "clips_missing",
      message:
        "The edit needs a clip for every shot. shot 2 submitted to Higgsfield but no clip has come back; shot 3 never submitted.",
    });
  });

  it("refuses to edit part of a reel when the plan and the frames disagree", () => {
    const result = editReadiness(brief, [frame(1), frame(2)]);
    expect(result).toMatchObject({
      ready: false,
      reason: "plan_frame_mismatch",
      message: "The plan has 3 shots and 2 are on file. The edit needs the whole reel.",
    });
  });

  it("refuses a brief that is not a reel, and one with no plan", () => {
    expect(editReadiness({ ...brief, media_type: "image", content_format: "carousel", format_code: null }, [])).
      toMatchObject({ reason: "not_a_reel" });
    expect(editReadiness({ ...brief, frame_plan: null }, [frame(1)])).toMatchObject({ reason: "no_shot_plan" });
    expect(editReadiness(brief, [])).toMatchObject({ reason: "no_frames" });
  });

  it("accepts an F7 reel whose content_format was never set", () => {
    expect(editReadiness({ ...brief, content_format: null, format_code: "F7" }, [frame(1), frame(2), frame(3)]).ready).toBe(
      true,
    );
  });
});

describe("maxReelSeconds", () => {
  it("uses the planned length, with a floor and the platform cap", () => {
    const shots = (lengths: number[]) =>
      lengths.map((plannedDurationSec, i) => ({
        shot: i + 1,
        frameId: `f${i}`,
        beat: "b",
        plannedDurationSec,
        shotSourceKind: "ai_generated",
        clipPath: "c.mp4",
        burnedInText: "",
      }));
    expect(maxReelSeconds(shots([4, 4, 4]))).toBe(12);
    expect(maxReelSeconds(shots([2, 2]))).toBe(10);
    expect(maxReelSeconds(shots(Array(30).fill(6)))).toBe(DEFAULT_MAX_REEL_SEC);
  });
});

describe("briefTextForEdit", () => {
  it("carries the words meant for the viewer and leaves out shooting notes", () => {
    const text = briefTextForEdit(brief);
    expect(text).toContain("Hook: Most gyms lose 30% of members by March.");
    expect(text).toContain("Call to action: Book a call.");
    expect(text).not.toContain("Proof:");
  });
});

describe("bannedPhrases", () => {
  it("splits a never_do field and drops fragments too short to match on", () => {
    expect(bannedPhrases("Never say guaranteed. No stock imagery; or\nhype words. a")).toEqual([
      "Never say guaranteed",
      "No stock imagery",
      // "or" is dropped: two characters would match inside ordinary words.
      "hype words",
    ]);
    expect(bannedPhrases(null)).toEqual([]);
  });
});

describe("editContext", () => {
  it("prefers the probed clip length over the planned one", () => {
    const result = editReadiness(brief, [frame(1), frame(2), frame(3)]);
    if (!result.ready) throw new Error("expected ready");
    const context = editContext({
      shots: result.shots,
      probedDurations: new Map([[1, 3.2]]),
      brief,
      neverDo: "Never say guaranteed",
    });
    expect(context.clips[0]!.duration_sec).toBe(3.2);
    expect(context.clips[1]!.duration_sec).toBe(4);
    expect(context.banned_phrases).toEqual(["Never say guaranteed"]);
    expect(context.max_total_sec).toBe(12);
  });
});

describe("the line already on the artwork", () => {
  it("travels from the frame row to the shot and into the edit context", () => {
    const frames = [1, 2, 3].map((i) => frame(i, { caption: i === 2 ? "  NOTHING LINKS THEM.  " : null }));
    const result = editReadiness(brief, frames);
    expect(result.ready).toBe(true);
    if (!result.ready) return;
    expect(result.shots.map((shot) => shot.burnedInText)).toEqual(["", "NOTHING LINKS THEM.", ""]);

    const context = editContext({
      shots: result.shots,
      probedDurations: new Map(result.shots.map((shot) => [shot.shot, 4])),
      brief,
    });
    expect(context.clips.map((clip) => clip.burned_in_text)).toEqual(["", "NOTHING LINKS THEM.", ""]);
  });
});
