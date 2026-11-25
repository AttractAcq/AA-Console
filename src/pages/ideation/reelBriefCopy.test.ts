import { describe, expect, it } from "vitest";
import { composeBody, composeAvatarBody, composeEditorBody } from "../../../agent-runtime/src/agents/brief/fields";
import { serializeShot, type ShotPlanEntry } from "../../../agent-runtime/src/agents/brief/shots";
import { prepareReelCopy } from "./reelBriefCopy";

function source() {
  const shot: ShotPlanEntry = { beat: "Cross the tiled floor.", opening_state: "Begin beside a tiled floor.",
    duration_sec: 4, shot_source_kind: "ai_generated", motion_preset: "slow_pan" };
  const input = { frames: [shot, { ...shot, duration_sec: 5 }], hook: "Old hook", argument: "Old argument",
    script: "SHOT 1: What fits?\nSHOT 2: Compare options.", visual_direction: "Old direction",
    shot_requirements: "Record the tiled floor.", proof: "Exact-source permission.", production_notes: "Keep the illustrative label." };
  const { production_notes: _notes, ...columns } = input;
  return { ...columns, frame_count: 2, frame_plan: input.frames.map(serializeShot),
    body: composeBody("video", input, "reel"), avatar_brief: composeAvatarBody(input), editor_brief: composeEditorBody(input) };
}

describe("editing an existing reel draft", () => {
  it("updates every handoff and the renderer's shot inputs together", () => {
    const b = source();
    const f = prepareReelCopy(b);
    const patch = f.revision({ ...f.initialValues, hook: "New hook", argument: "A planning question",
      script: "SHOT 1: Which path?\nSHOT 2: Compare options.", visual_direction: "Follow the cart.",
      beat0: "Pass the cart.", opening_state0: "Start at the bench." }, "", null);
    for (const doc of [patch.body, patch.avatar_brief, patch.editor_brief]) {
      expect(doc).toContain("Which path?");
      expect(doc).toContain("1. Pass the cart. Start: Start at the bench.");
      expect(doc).toContain("Keep the illustrative label.");
      expect(doc).not.toContain("Old hook");
    }
    expect(patch.body).toContain("Exact-source permission.");
    expect(patch.editor_brief).toContain("A planning question");
    expect(JSON.parse(patch.frame_plan[0])).toEqual({ ...JSON.parse(b.frame_plan[0]), beat: "Pass the cart.", opening_state: "Start at the bench." });
    expect(patch.frame_plan[1]).toBe(b.frame_plan[1]);
    expect(patch).not.toHaveProperty("status");
    expect(patch).not.toHaveProperty("proof_asset_id");
  });
  it("refuses divergent handoffs or invalid shot and caption edits", () => {
    expect(() => prepareReelCopy({ ...source(), avatar_brief: "operator notes" })).toThrow(/differ/);
    const f = prepareReelCopy(source());
    expect(() => f.revision({ ...f.initialValues, script: "SHOT 1: Missing a caption" }, "", null)).toThrow(/caption/);
    expect(() => f.revision({ ...f.initialValues, beat1: "" }, "", null)).toThrow(/beat/);
  });
});
