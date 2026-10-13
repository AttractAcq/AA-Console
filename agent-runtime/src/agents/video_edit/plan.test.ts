import { describe, expect, it } from "vitest";

import { MAX_CAPTION_CHARS, MAX_END_CARD_SEC, TRANSITIONS, type Edl } from "./edl.js";
import { briefCopyProblems, buildPlanContent, communicationProblems, sameRenderedCut, type PlanInput } from "./plan.js";
import type { BriefForEdit } from "./handoff.js";

const input: PlanInput = {
  title: "Spike reel",
  briefText: "Hook: most gyms lose 30% of members by March.",
  maxTotalSec: 15,
  bannedPhrases: ["guaranteed", ""],
  clips: [
    {
      shot: 1,
      beat: "cold open",
      duration_sec: 5,
      shot_source_kind: "ai_generated",
      burnedInText: "",
      frames: [
        { atSec: 0, jpeg: Buffer.from("a") },
        { atSec: 0.5, jpeg: Buffer.from("b") },
      ],
    },
    { shot: 2, beat: "proof", duration_sec: 3, shot_source_kind: "source_asset", burnedInText: "", frames: [] },
  ],
};

function texts(content: ReturnType<typeof buildPlanContent>): string[] {
  return content.flatMap((block) => (block.type === "text" ? [block.text] : []));
}

describe("buildPlanContent", () => {
  it("labels every frame with its shot and time, before the image", () => {
    const content = buildPlanContent(input);
    const labelIndex = content.findIndex((b) => b.type === "text" && b.text === "Shot 1 at 0.50s");
    expect(labelIndex).toBeGreaterThan(0);
    expect(content[labelIndex + 1]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: Buffer.from("b").toString("base64") },
    });
  });

  it("states the limits, the bans and which shots are client footage", () => {
    const all = texts(buildPlanContent(input)).join("\n");
    expect(all).toContain("Maximum length including any end card: 15s.");
    expect(all).toContain("The brand never uses: guaranteed.");
    expect(all).toContain("SHOT 2: proof. Clip length 3.00s. Client footage: cut only, no crossfade.");
  });

  it("sends every validation problem back on a revise", () => {
    const revise = {
      edl: { segments: [], captions: [], end_card_text: "", end_card_sec: 0, notes: "" },
      problems: ["The reel runs 20.0s. This format allows 15s.", "Caption 1 is empty."],
    };
    const last = texts(buildPlanContent({ ...input, revise })).at(-1)!;
    expect(last).toContain("- The reel runs 20.0s. This format allows 15s.");
    expect(last).toContain("- Caption 1 is empty.");
    expect(last).toContain('"segments":[]');
  });

  it("passes the exact failed candidate's reason into the next cut", () => {
    const all = texts(buildPlanContent({ ...input, priorCandidateFailure: {
      candidateId: "candidate-1", reason: "Caption obscured the owner's face at 4 seconds.",
      editPlan: { segments: [{ shot: 1 }] },
    } })).join("\n");
    expect(all).toContain("PRIOR FINAL-CUT FAILURE (candidate-1)");
    expect(all).toContain("Caption obscured the owner's face at 4 seconds.");
    expect(all).toContain('Rejected edit plan: {"segments":[{"shot":1}]}');
  });

  it("refuses a renamed rationale when the rendered cut is identical", () => {
    const prior: Edl = { segments: [{ shot: 1, in_sec: 0, out_sec: 3,
      transition: "cut" }], captions: [{ text: "A caption", start_sec: 0,
      end_sec: 2, position: "bottom" }], end_card_text: "CTA", end_card_sec: 1,
    notes: "first rationale" };
    const candidate: Edl = { ...prior, notes: "new rationale" };
    expect(sameRenderedCut(candidate, prior)).toBe(true);
    expect(sameRenderedCut({ ...candidate, captions: [{ ...candidate.captions[0]!,
      text: "A better caption" }] }, prior))
      .toBe(false);
  });
});

/**
 * The planner has to know which shots carry their own line, or it writes
 * captions that the validator then has to refuse — a revise call, paid for,
 * to learn something the prompt could have said up front.
 */
describe("shots that already carry their line", () => {
  const withText: PlanInput = {
    ...input,
    clips: [
      { ...input.clips[0]!, burnedInText: "NOTHING LINKS THEM." },
      input.clips[1]!,
    ],
  };

  it("tells the model what the artwork already says, and not to caption over it", () => {
    const shotLine = texts(buildPlanContent(withText)).find((t) => t.startsWith("SHOT 1:"))!;
    expect(shotLine).toContain('Already on screen: "NOTHING LINKS THEM."');
    expect(shotLine).toContain("do not caption over this shot");
  });

  it("says nothing of the sort about a shot with no text in it", () => {
    const shotLine = texts(buildPlanContent(withText)).find((t) => t.startsWith("SHOT 2:"))!;
    expect(shotLine).not.toContain("Already on screen");
    expect(shotLine).not.toContain("do not caption");
  });

  it("tells the editor in the system prompt that no captions is a valid plan", async () => {
    const { SYSTEM } = await import("./plan.js");
    expect(SYSTEM).toMatch(/fully lettered\s+artwork can need no captions/i);
    expect(SYSTEM).toMatch(/already on screen/i);
  });
});

describe("silent reel communication", () => {
  const edl = {
    segments: [], captions: [], end_card_text: "", end_card_sec: 0, notes: "",
  };
  it("requires an opening hook and a second beat when source clips have no text", () => {
    expect(communicationProblems(edl, input.clips)).toHaveLength(2);
    expect(communicationProblems({ ...edl, captions: [
      { text: "Hook", start_sec: 0.5, end_sec: 2, position: "bottom" },
      { text: "Argument", start_sec: 4, end_sec: 6, position: "bottom" },
    ] }, input.clips)).toEqual([]);
  });
  it("keeps lettered legacy footage eligible for a caption-free cut", () => {
    expect(communicationProblems(edl, [{ ...input.clips[0]!, burnedInText: "A hook" }])).toEqual([]);
  });
  it("asks for a revision when silent-footage captions cover too much of the frame", () => {
    const problems = communicationProblems({ ...edl, captions: [
      { text: "Before you raise the budget read your own offer as a stranger would", start_sec: 0, end_sec: 3, position: "middle" },
      { text: "Fix the offer first", start_sec: 4, end_sec: 6, position: "bottom" },
    ] }, input.clips);
    expect(problems).toContainEqual(expect.stringContaining("more than two lines"));
  });
});

it("catches the live reel's rewritten hook and truncated CTA before rendering", () => {
  const brief = {
    hook: 'First caption: "Three weeks. A report you can\'t put your name to."',
    call_to_action: 'Caption: "Ask every provider — including us. Ours is written down. attractacq.com, or DM @attractacq and ask Alex Thomas for it."',
  } as BriefForEdit;
  const cut: Edl = { segments: [], captions: [
    { text: "Three weeks. A report you can't defend.", start_sec: 0, end_sec: 3, position: "bottom" },
    { text: "Ours is written down.", start_sec: 10, end_sec: 12, position: "bottom" },
    { text: "attractacq.com or DM @attractacq", start_sec: 17, end_sec: 20, position: "bottom" },
  ], end_card_text: "Ask every provider — including us.", end_card_sec: 2, notes: "" };
  expect(briefCopyProblems(cut, brief)).toHaveLength(2);
  const exact: Edl = { ...cut, captions: [
    { text: "Three weeks. A report you can't put your name to.", start_sec: 0, end_sec: 4, position: "bottom" },
    { text: "Ask every provider — including us. Ours is written down.", start_sec: 12, end_sec: 15, position: "bottom" },
    { text: "attractacq.com, or DM @attractacq and ask Alex Thomas for it.", start_sec: 15, end_sec: 20, position: "bottom" },
  ], end_card_text: "", end_card_sec: 0 };
  expect(briefCopyProblems(exact, brief)).toEqual([]);
  const splitHook: Edl = { ...exact, captions: [
    { text: "Three weeks.", start_sec: 0, end_sec: 1, position: "bottom" },
    { text: "A report you can't put your name to.", start_sec: 1, end_sec: 4, position: "bottom" },
    ...exact.captions.slice(1),
  ] };
  expect(briefCopyProblems(splitHook, brief)[0]).toMatch(/one caption plate/);
  expect(briefCopyProblems(exact, { ...brief,
    hook: 'The first caption reads: "Three weeks. A report you can\'t put your name to."',
  })).toEqual([]);
  expect(briefCopyProblems(splitHook, { ...brief,
    hook: 'Exact first caption, burned in: "Three weeks. A report you can\'t put your name to."',
  })[0]).toMatch(/one caption plate/);
  expect(briefCopyProblems({ ...exact, end_card_text: "Read the plan.", end_card_sec: 2 },
    { call_to_action: "Read the plan." } as BriefForEdit)).toEqual([]);
});

// A limit the validator enforces but the prompt never states is only
// discoverable by failing. That cost a full revise round in the 10 October
// model comparison: Fable returned a 70-character end card and a 22.8s
// end_card_sec, both against rules it had not been given. These assert the
// prompt carries every limit validateEdl checks, so the two cannot drift.
describe("the prompt states the limits the validator enforces", () => {
  const stated = () => texts(buildPlanContent(input)).join("\n");

  it("gives the caption and end card character limit", () => {
    expect(stated()).toContain(`${MAX_CAPTION_CHARS} characters`);
  });

  it("gives the end card duration range", () => {
    expect(stated()).toContain(`between 1 and ${MAX_END_CARD_SEC}s`);
  });

  // Asserting each name appears somewhere in the prompt passes without the
  // list: "Client footage: cut only, no crossfade" already contains both.
  // Match the line that enumerates them.
  it("lists every transition the validator accepts", () => {
    const line = texts(buildPlanContent(input)).join("\n").split("\n").find((l) => l.startsWith("Transitions available:"));
    expect(line).toBeDefined();
    for (const transition of TRANSITIONS) expect(line).toContain(transition);
  });
});
