import { describe, expect, it } from "vitest";

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
      frames: [
        { atSec: 0, jpeg: Buffer.from("a") },
        { atSec: 0.5, jpeg: Buffer.from("b") },
      ],
    },
    { shot: 2, beat: "proof", duration_sec: 3, shot_source_kind: "source_asset", frames: [] },
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
