import { describe, expect, it } from "vitest";

import { MAX_CAPTION_CHARS, MAX_END_CARD_SEC, TRANSITIONS } from "./edl.js";
import { buildPlanContent, type PlanInput } from "./plan.js";

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
    expect(SYSTEM).toMatch(/no captions is a good plan/i);
    expect(SYSTEM).toMatch(/already on screen/i);
  });
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
