import { describe, expect, it } from "vitest";

import { unsupportedStrictKeywords } from "../../tools/schema.js";
import {
  CROSSFADE_SEC,
  EDL_SCHEMA,
  parseEdl,
  segmentWindows,
  totalDuration,
  validateEdl,
  type Edl,
  type EdlContext,
} from "./edl.js";

const context: EdlContext = {
  clips: [
    { shot: 1, duration_sec: 5, shot_source_kind: "ai_generated", burned_in_text: "" },
    { shot: 2, duration_sec: 5, shot_source_kind: "ai_generated", burned_in_text: "" },
    { shot: 3, duration_sec: 4, shot_source_kind: "source_asset", burned_in_text: "" },
  ],
  max_total_sec: 15,
  brief_text: "Most gyms lose 30% of members by March. A 3 step check-in. Book a call.",
  banned_phrases: ["guaranteed", " "],
};

function plan(overrides: Partial<Edl> = {}): Edl {
  return {
    segments: [
      { shot: 1, in_sec: 0, out_sec: 3, transition: "cut" },
      { shot: 2, in_sec: 1, out_sec: 4, transition: "crossfade" },
    ],
    captions: [{ text: "Most gyms lose 30% of members", start_sec: 0.2, end_sec: 2.5, position: "middle" }],
    end_card_text: "Book a call",
    end_card_sec: 2,
    notes: "",
    ...overrides,
  };
}

describe("EDL_SCHEMA", () => {
  it("is accepted for a strict tool", () => {
    expect(unsupportedStrictKeywords(EDL_SCHEMA)).toEqual([]);
  });
});

describe("parseEdl", () => {
  it("accepts a well-formed plan", () => {
    const result = parseEdl(plan());
    expect(result.ok).toBe(true);
  });

  it("refuses a plan with no segments", () => {
    expect(parseEdl({ ...plan(), segments: [] })).toEqual({ ok: false, problem: "The edit plan has no segments." });
  });

  it("refuses an unknown transition rather than passing it to ffmpeg", () => {
    const raw = plan({ segments: [{ shot: 1, in_sec: 0, out_sec: 2, transition: "wipe" as never }] });
    expect(parseEdl(raw)).toMatchObject({ ok: false, problem: "Segment 1 has an unknown transition." });
  });

  it("refuses a non-integer shot", () => {
    const raw = plan({ segments: [{ shot: 1.5, in_sec: 0, out_sec: 2, transition: "cut" }] });
    expect(parseEdl(raw).ok).toBe(false);
  });

  it("drops the end card length when there is no end card text", () => {
    const result = parseEdl(plan({ end_card_text: "  ", end_card_sec: 3 }));
    expect(result.ok && result.edl.end_card_sec).toBe(0);
  });
});

describe("totalDuration", () => {
  it("subtracts crossfade overlap and adds the end card", () => {
    expect(totalDuration(plan())).toBeCloseTo(3 + 3 - CROSSFADE_SEC + 2);
  });
});

describe("validateEdl", () => {
  it("passes a plan inside every limit", () => {
    expect(validateEdl(plan(), context)).toEqual([]);
  });

  it("flags a segment past the end of its clip", () => {
    const problems = validateEdl(plan({ segments: [{ shot: 1, in_sec: 2, out_sec: 6, transition: "cut" }] }), context);
    expect(problems).toContain("Segment 1 (shot 1) runs outside the clip, which is 5.00s long.");
  });

  it("flags a shot that has no clip", () => {
    const problems = validateEdl(plan({ segments: [{ shot: 9, in_sec: 0, out_sec: 2, transition: "cut" }] }), context);
    expect(problems).toContain("Segment 1 (shot 9) names a shot that has no clip.");
  });

  it("flags flash frames", () => {
    const problems = validateEdl(plan({ segments: [{ shot: 1, in_sec: 0, out_sec: 0.2, transition: "cut" }] }), context);
    expect(problems.some((p) => p.includes("shortest usable segment"))).toBe(true);
  });

  it("refuses a crossfade over client footage", () => {
    const segments = [
      { shot: 1, in_sec: 0, out_sec: 3, transition: "cut" as const },
      { shot: 3, in_sec: 0, out_sec: 3, transition: "crossfade" as const },
    ];
    expect(validateEdl(plan({ segments }), context)).toContain(
      "Segment 2 (shot 3) crossfades over client footage. Proof shots are cut, not blended.",
    );
  });

  it("flags a reel longer than the format allows", () => {
    const segments = [1, 2, 1, 2].map((shot) => ({ shot, in_sec: 0, out_sec: 4.5, transition: "cut" as const }));
    expect(validateEdl(plan({ segments }), context).some((p) => p.startsWith("The reel runs"))).toBe(true);
  });

  it("flags a figure the brief does not contain", () => {
    const captions = [{ text: "Members up 45%", start_sec: 0, end_sec: 2, position: "top" as const }];
    expect(validateEdl(plan({ captions }), context)).toContain('Caption 1 says "45", which is not in the brief.');
  });

  it("flags brand-banned phrases in captions and the end card, ignoring blank entries", () => {
    const problems = validateEdl(plan({ end_card_text: "Guaranteed results" }), context);
    expect(problems).toEqual(['The end card uses "guaranteed", which the brand bans.']);
  });

  it("flags captions too short to read, outside the reel, or overlapping", () => {
    const captions = [
      { text: "One", start_sec: 0, end_sec: 0.3, position: "bottom" as const },
      { text: "Two", start_sec: 0.2, end_sec: 1.5, position: "bottom" as const },
      { text: "Three", start_sec: 7, end_sec: 9, position: "top" as const },
    ];
    const problems = validateEdl(plan({ captions }), context);
    expect(problems).toContain("Caption 1 is on screen for under 0.8s, too short to read.");
    expect(problems).toContain("Two bottom captions overlap at 0.2s.");
    expect(problems).toContain("Caption 3 runs outside the reel.");
  });

  it("flags captions too long to fit the frame", () => {
    const captions = [{ text: "x".repeat(61), start_sec: 0, end_sec: 2, position: "top" as const }];
    expect(validateEdl(plan({ captions }), context)).toContain("Caption 1 is 61 characters. It has to fit in 60.");
  });

  it("flags an end card outside 1 to 4 seconds", () => {
    expect(validateEdl(plan({ end_card_sec: 6 }), context)).toContain(
      "The end card runs 6s. It has to be between 1 and 4s.",
    );
  });
});

/**
 * Higgsfield burns the script line into each still, so the artwork arrives
 * with its own typography in it. On AA-0121 all six shots carried a line and
 * the planner put three captions on top of them anyway — in DejaVu, over a
 * condensed grotesque, mid-frame where the artwork puts its subject. The
 * render was correct and the reel was unusable.
 */
describe("a caption never lands on artwork that already has text", () => {
  const withText: EdlContext = {
    ...context,
    clips: [
      { shot: 1, duration_sec: 5, shot_source_kind: "ai_generated", burned_in_text: "NOTHING LINKS THEM." },
      { shot: 2, duration_sec: 5, shot_source_kind: "ai_generated", burned_in_text: "" },
      { shot: 3, duration_sec: 4, shot_source_kind: "source_asset", burned_in_text: "" },
    ],
  };

  // Shot 1 runs 0-3s on the timeline, shot 2 from 3s.
  const over = (start: number, end: number): Edl =>
    plan({ captions: [{ text: "A line of commentary", start_sec: start, end_sec: end, position: "middle" }] });

  it("refuses one that overlaps the shot carrying the line, and names it", () => {
    const problems = validateEdl(over(0.5, 2.5), withText);
    expect(problems).toContainEqual(expect.stringMatching(/Caption 1 is on screen over shot 1/));
    expect(problems).toContainEqual(expect.stringMatching(/already shows its own line/));
  });

  it("refuses one that only clips the edge of it", () => {
    expect(validateEdl(over(2.5, 4.5), withText)).toContainEqual(expect.stringMatching(/over shot 1/));
  });

  it("allows one that sits entirely on a shot with no text of its own", () => {
    expect(validateEdl(over(3.2, 5), withText)).toEqual([]);
  });

  it("allows captions when no shot has a burned-in line", () => {
    expect(validateEdl(over(0.5, 2.5), context)).toEqual([]);
  });

  it("names every shot a caption straddles", () => {
    const both: EdlContext = {
      ...withText,
      clips: withText.clips.map((clip) => ({ ...clip, burned_in_text: `LINE ${clip.shot}` })),
    };
    const problems = validateEdl(over(2.5, 4.5), both);
    expect(problems).toContainEqual(expect.stringMatching(/over shot 1 and shot 2/));
  });

  it("does not fire on a caption that only touches the boundary", () => {
    // Shot 1 ends at 3s. A caption from 3s on belongs to shot 2.
    expect(validateEdl(over(3.0, 5), withText)).toEqual([]);
  });
});

describe("segmentWindows", () => {
  it("places a crossfaded segment where it actually starts, overlapping its predecessor", () => {
    const windows = segmentWindows([
      { shot: 1, in_sec: 0, out_sec: 2, transition: "cut" },
      { shot: 2, in_sec: 0, out_sec: 2, transition: "cut" },
      { shot: 1, in_sec: 0, out_sec: 2, transition: "crossfade" },
    ]);
    expect(windows).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
      { start: 4 - CROSSFADE_SEC, end: 6 - CROSSFADE_SEC },
    ]);
  });

  it("agrees with segmentsDuration", () => {
    const segments = plan().segments;
    const windows = segmentWindows(segments);
    expect(windows[windows.length - 1]!.end).toBeCloseTo(totalDuration({ ...plan(), end_card_text: "" }), 5);
  });
});
