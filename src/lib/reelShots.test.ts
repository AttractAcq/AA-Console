import { describe, expect, it } from "vitest";
import { buildReelMasters, cutState, isPhase1MotionBrief, readShotPlan } from "./reelShots";
import type { ShotRow } from "./reelShots";

const shot = (beat: string) =>
  JSON.stringify({
    beat,
    duration_sec: 3,
    motion_preset: "pending",
    shot_source_kind: "ai_generated",
  });

describe("isPhase1MotionBrief", () => {
  it("accepts an F6 or F7 video, and a reel with no format code", () => {
    expect(isPhase1MotionBrief({ media_type: "video", content_format: "reel", format_code: "F6" })).toBe(true);
    expect(isPhase1MotionBrief({ media_type: "video", content_format: "single", format_code: "F7" })).toBe(true);
    expect(isPhase1MotionBrief({ media_type: "video", content_format: "reel", format_code: null })).toBe(true);
  });

  it("refuses a still, a video story, and a later-phase reel", () => {
    expect(isPhase1MotionBrief({ media_type: "image", content_format: "carousel", format_code: null })).toBe(false);
    expect(isPhase1MotionBrief({ media_type: "video", content_format: "story", format_code: null })).toBe(false);
    expect(isPhase1MotionBrief({ media_type: "video", content_format: "reel", format_code: "F5" })).toBe(false);
  });
});

describe("readShotPlan", () => {
  it("reads the JSON shots the brief agent stored", () => {
    const plan = readShotPlan([shot("Name the mechanism"), shot("Show the step")]);
    expect(plan.problem).toBeNull();
    expect(plan.shots.map((row) => row.beat)).toEqual(["Name the mechanism", "Show the step"]);
  });

  it("says when a line is not a shot", () => {
    expect(readShotPlan(["hook", "proof"]).problem).toMatch(/not a shot record/);
  });
});

describe("buildReelMasters", () => {
  const brief = {
    id: "brief-1",
    title: "How it works",
    brief_ref: "BR-9",
    status: "in_production",
    content_format: "reel",
    format_code: "F6",
    media_type: "video",
    frame_plan: [shot("Name the mechanism"), shot("Show the step")],
  };

  it("shows the plan when no master exists yet", () => {
    const [master] = buildReelMasters([brief], [], []);
    expect(master?.plannedShots).toHaveLength(2);
    expect(master?.plannedShots[0]).toMatchObject({
      beat: "Name the mechanism",
      still: "No still",
      clip: "No clip",
      source: "Generated",
      motion: "pending",
    });
    expect(master?.assets).toHaveLength(0);
  });

  it("overlays a frame's still and clip onto the matching shot", () => {
    const [master] = buildReelMasters(
      [brief],
      [{ id: "asset-1", brief_id: "brief-1", title: "Cut", ref_number: "MD-1", review_status: "pending" }],
      [
        {
          asset_id: "asset-1",
          position: 1,
          storage_path: "c/still.png",
          caption: null,
          beat: null,
          duration_sec: null,
          motion_preset: "pending",
          clip_path: "c/clip.mp4",
          shot_source_kind: "ai_generated",
          provider_job_id: "req-1",
        },
      ],
    );
    expect(master?.assets[0]?.shots[0]).toMatchObject({ still: "Still on file", clip: "Clip on file" });
    expect(master?.assets[0]?.shots[1]).toMatchObject({ still: "No still", clip: "No clip" });
  });

  it("leaves an F5 reel out of the Phase 1 grid", () => {
    expect(buildReelMasters([{ ...brief, format_code: "F5" }], [], [])).toHaveLength(0);
  });
});

describe("where a reel's cut has got to", () => {
  const shots = (withClips: number, total = 3): ShotRow[] =>
    Array.from({ length: total }, (_, i) => ({
      position: i + 1,
      beat: `beat ${i + 1}`,
      durationLabel: "3s",
      source: "Generated",
      motion: "pending",
      still: "Still on file" as const,
      clip: (i < withClips ? "Clip on file" : "No clip") as ShotRow["clip"],
    }));

  it("says the cut is on file once one has been rendered", () => {
    const state = cutState({ render_path: "cuts/a.mp4" }, shots(3), []);
    expect(state).toMatchObject({ status: "cut", canRequest: false });
  });

  it("does not offer a second cut while one is running", () => {
    // request_video_edit refuses a second anyway. Offering the button is
    // offering an error.
    for (const status of ["queued", "claimed", "running"]) {
      const state = cutState({}, shots(3), [{ input_id: "a", status }]);
      expect(state.canRequest).toBe(false);
      expect(state.status).toBe("running");
    }
  });

  it("gives the runner's own reason when the last cut failed", () => {
    // It is the only part of the failure anyone can act on.
    const state = cutState({}, shots(3), [
      { input_id: "a", status: "failed", error: "Shot 2 has no clip." },
    ]);
    expect(state.detail).toContain("Shot 2 has no clip.");
    expect(state.canRequest).toBe(true);
  });

  it("says so rather than inventing a reason when none was recorded", () => {
    const state = cutState({}, shots(3), [{ input_id: "a", status: "failed", error: null }]);
    expect(state.detail).toContain("no reason recorded");
  });

  it("counts the clips that are actually on file", () => {
    expect(cutState({}, shots(1), []).detail).toBe("1 of 3 clips on file.");
    expect(cutState({}, shots(3), []).detail).toBe("All 3 clips on file.");
    expect(cutState({}, [], []).detail).toBe("No shots on this reel.");
  });

  it("waits for clips before offering the cut, and says what is missing", () => {
    const state = cutState({}, shots(1), []);
    expect(state).toMatchObject({ status: "incomplete", canRequest: false });
    expect(state.detail).toContain("1 of 3");
  });

  it("treats an old finished job as no job at all", () => {
    const state = cutState({}, shots(3), [{ input_id: "a", status: "succeeded" }]);
    expect(state).toMatchObject({ status: "ready", canRequest: true });
  });

  it("reads each asset's own jobs and nobody else's", () => {
    const masters = buildReelMasters(
      [
        {
          id: "brief-1",
          title: "How it works",
          brief_ref: null,
          status: "in_production",
          content_format: "reel",
          format_code: "F6",
          media_type: "video",
          frame_plan: [shot("Name the mechanism")],
        },
      ],
      [
        { id: "asset-1", brief_id: "brief-1", title: null, ref_number: null, review_status: "pending" },
        { id: "asset-2", brief_id: "brief-1", title: null, ref_number: null, review_status: "pending" },
      ],
      [],
      [{ input_id: "asset-2", status: "running" }],
    );
    const [one, two] = masters[0]!.assets;
    expect(one!.cut.status).not.toBe("running");
    expect(two!.cut.status).toBe("running");
  });
});
