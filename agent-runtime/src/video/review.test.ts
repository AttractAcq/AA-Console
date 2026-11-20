import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { reviewVideoStoryboard, VideoReviewValidationError } from "./review.js";
import type { VideoStoryboard, VideoSource } from "./storyboard.js";

const ir = JSON.parse(readFileSync(resolve(import.meta.dirname,
  "../../../video-render/fixtures/ir/three-scene-v2.json"), "utf8"));
const storyboard: VideoStoryboard = { ir,
  sceneSources: ir.scenes.map((scene: { id: string }) => ({
    sceneId: scene.id, sourceIds: ["source-1"],
  })),
  sourceDigest: "a".repeat(64), unsourced: false, attempts: 1,
  usage: { inputTokens: 100, outputTokens: 200, costUsd: 0.005 },
};
const sources: VideoSource[] = [{ id: "source-1", kind: "business",
  asOf: "2026-11-20", text: "The operator reviews the exact version before release." }];
const usage = { inputTokens: 50, outputTokens: 80, costUsd: 0.002 };
const complete = (body: unknown) => vi.fn().mockResolvedValue({ text: JSON.stringify(body), usage });

describe("independent video review", () => {
  it("applies a sourced narration edit and revalidates the IR", async () => {
    const result = await reviewVideoStoryboard(storyboard, sources, complete({
      verdict: "pass", reasons: ["Clarified the final review action."],
      edits: [{ sceneId: "s03", field: "narration",
        value: "An operator reviews the exact version before release.",
        sourceIds: ["source-1"] }],
    }));
    expect(result).toMatchObject({ accepted: true, edits: 1, usage });
    expect(result.ir.scenes[2]).toMatchObject({
      narration: "An operator reviews the exact version before release.",
    });
    expect(storyboard.ir.scenes[2]).not.toMatchObject({
      narration: "An operator reviews the exact version before release.",
    });
  });
  it("keeps the original IR held when accuracy review fails", async () => {
    const result = await reviewVideoStoryboard(storyboard, sources, complete({
      verdict: "fail", reasons: ["The claim has no source evidence."], edits: [],
    }));
    expect(result).toMatchObject({ accepted: false,
      reasons: ["The claim has no source evidence."], edits: 0 });
    expect(result.ir).toEqual(storyboard.ir);
  });
  it("rejects an unknown citation or invalid props even after reviewer pass", async () => {
    await expect(reviewVideoStoryboard(storyboard, sources, complete({
      verdict: "pass", reasons: [], edits: [{ sceneId: "s02", field: "narration",
        value: "Explain the service.", sourceIds: ["unknown"] }],
    }))).rejects.toBeInstanceOf(VideoReviewValidationError);
    await expect(reviewVideoStoryboard(storyboard, sources, complete({
      verdict: "pass", reasons: [], edits: [{ sceneId: "s02", field: "props",
        value: { heading: "Too many words in this heading for the component", items: ["A"] },
        sourceIds: ["source-1"] }],
    }))).rejects.toBeInstanceOf(VideoReviewValidationError);
  });
});
