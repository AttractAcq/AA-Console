import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { batchPreRenderFrames, reviewPreRenderStills }
  from "./prerender-critic.js";
import type { PreRenderFrame } from "./prerender-stills.js";

const ir = JSON.parse(readFileSync(resolve(import.meta.dirname,
  "../../../../video-render/fixtures/ir/three-scene-v2.json"), "utf8"));
const jpeg = Buffer.alloc(120, 1);
const frames: PreRenderFrame[] = ir.scenes.flatMap((scene: { id: string }, index: number) =>
  [6, 30, 54].map((offset) => ({ sceneId: scene.id,
    frame: index * 60 + offset, jpeg, costUsd: 0.01,
    renderId: `render-${index}-${offset}` })));
const areas = ["text_overflow", "caption_overlap", "contrast", "safe_area",
  "reading_time", "brand_token", "empty_frame", "narration_visual_match"];
const usage = { inputTokens: 100, outputTokens: 20,
  cacheReadTokens: 0, cacheWriteTokens: 0 };
function report(failed?: string, patch: unknown[] = []) {
  return { result: failed ? "fail" : "pass",
    checks: areas.map((area) => ({ area,
      verdict: area === failed ? "fail" : "pass", sceneId: "s02",
      reason: `${area} checked.` })), patch };
}

describe("pre-render visual critic", () => {
  it("keeps no more than 90 sampled images in each request", () => {
    const sample = Array.from({ length: 120 }, (_, index) => ({
      ...frames[index % frames.length]!, frame: index }));
    expect(batchPreRenderFrames(sample).map((batch) => batch.length))
      .toEqual([90, 30]);
  });

  it("parses a failing report with a bounded scene patch and cost", async () => {
    const complete = vi.fn(async () => ({
      raw: report("reading_time", [{ op: "shorten_text", sceneId: "s02",
        path: "props.heading", value_json: '"Then"' }]),
      model: "claude-sonnet-4-5", usage }));
    const reviewed = await reviewPreRenderStills({ frames, ir,
      brandRules: "AA navy", model: "claude-sonnet-4-5", apiKey: "test" },
    complete);
    expect(reviewed).toMatchObject({ result: "fail", sampled_frames: 9,
      batches: 1, patch: [{ op: "shorten_text", sceneId: "s02",
        path: "props.heading", value: "Then" }] });
    expect(reviewed.usage.costUsd).toBeGreaterThan(0);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("rejects contradictory, duplicate and unsampled-scene reports", async () => {
    const complete = vi.fn(async () => ({ raw: report(),
      model: "claude-sonnet-4-5", usage }));
    const input = { frames, ir, brandRules: "AA navy",
      model: "claude-sonnet-4-5", apiKey: "test" };
    complete.mockResolvedValueOnce({ raw: { ...report(), result: "fail" },
      model: "claude-sonnet-4-5", usage });
    await expect(reviewPreRenderStills(input, complete))
      .rejects.toThrow(/verdict conflicts/);
    complete.mockResolvedValueOnce({ raw: { ...report(),
      checks: [...report().checks.slice(0, 7), report().checks[0]!] },
    model: "claude-sonnet-4-5", usage });
    await expect(reviewPreRenderStills(input, complete))
      .rejects.toThrow(/invalid area/);
    complete.mockResolvedValueOnce({ raw: report("reading_time", [
      { op: "set_prop", sceneId: "s09", path: "props.title",
        value_json: '"New"' }]), model: "claude-sonnet-4-5", usage });
    await expect(reviewPreRenderStills(input, complete))
      .rejects.toThrow(/invalid scene/);
  });

  it("fails when frame identity does not match IR before paying the model", async () => {
    const complete = vi.fn();
    await expect(reviewPreRenderStills({ frames: frames.slice(1), ir,
      brandRules: "AA navy", model: "claude-sonnet-4-5",
      apiKey: "test" }, complete as never))
      .rejects.toThrow(/exact IR scenes/);
    expect(complete).not.toHaveBeenCalled();
  });
});
