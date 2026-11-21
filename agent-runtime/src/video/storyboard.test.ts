import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { VideoStoryboardValidationError, writeVideoStoryboard,
  type VideoCompletion, type VideoStoryboardRequest } from "./storyboard.js";

const ir = JSON.parse(readFileSync(resolve(import.meta.dirname,
  "../../../video-render/fixtures/ir/three-scene-v2.json"), "utf8"));
const request: VideoStoryboardRequest = {
  idea: "Explain the service through a clear three-step story.",
  audience: "AA operators", tone: "calm", targetLengthSec: 90,
  aspects: ["16:9", "9:16", "1:1"], catalogue: "TitleCard, BulletReveal, Outro",
  sources: [{ id: "business-1", kind: "business", asOf: "2026-11-20",
    text: "The operator reviews the exact version before release." }],
};
const response = (sourceId = "business-1") => JSON.stringify({ ir,
  sceneSources: ir.scenes.map((scene: { id: string }) => ({ sceneId: scene.id,
    sourceIds: [sourceId] })) });
const usage = { inputTokens: 100, outputTokens: 200, costUsd: 0.005 };

describe("source-bound video storyboard writer", () => {
  it("accepts valid IR with scene coverage and records source digest and usage", async () => {
    const complete = vi.fn<VideoCompletion>().mockResolvedValue({ text: response(), usage });
    const result = await writeVideoStoryboard(request, complete);
    expect(result.ir.scenes).toHaveLength(3);
    expect(result.sceneSources).toHaveLength(3);
    expect(result.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result).toMatchObject({ attempts: 1, unsourced: false, usage });
    expect(complete.mock.calls[0]?.[0]).toContain('"id":"business-1"');
  });
  it("repairs invalid JSON once and accounts for both calls", async () => {
    const complete = vi.fn<VideoCompletion>()
      .mockResolvedValueOnce({ text: "not JSON", usage })
      .mockResolvedValueOnce({ text: response(), usage });
    const result = await writeVideoStoryboard(request, complete);
    expect(result).toMatchObject({ attempts: 2,
      usage: { inputTokens: 200, outputTokens: 400, costUsd: 0.01 } });
    expect(complete.mock.calls[1]?.[0]).toContain("response must be a single JSON object");
  });
  it("holds unknown or missing scene citations after two tries", async () => {
    const complete = vi.fn<VideoCompletion>().mockResolvedValue({ text: response("unknown"), usage });
    let thrown: unknown;
    try { await writeVideoStoryboard(request, complete); }
    catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(VideoStoryboardValidationError);
    expect((thrown as VideoStoryboardValidationError).usage).toMatchObject({ costUsd: 0.01 });
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it("labels an operator-only idea unsourced and restricts citations", async () => {
    const unsourced = { ...request, sources: [] };
    const complete = vi.fn<VideoCompletion>().mockResolvedValue({ text: response("operator_prompt"), usage });
    expect(await writeVideoStoryboard(unsourced, complete)).toMatchObject({ unsourced: true });
    expect(complete.mock.calls[0]?.[0]).toContain("No sourced business facts supplied");
  });
  it("rejects a changed aspect and duplicate scene source row", async () => {
    const changed = JSON.parse(response());
    changed.ir.aspects = ["16:9"];
    changed.sceneSources[2] = changed.sceneSources[1];
    const complete = vi.fn<VideoCompletion>().mockResolvedValue({ text: JSON.stringify(changed), usage });
    await expect(writeVideoStoryboard(request, complete)).rejects.toThrow(/IR aspects differ|sceneSources/);
  });
  it("rejects oversized or duplicate source packets before a model call", async () => {
    const complete = vi.fn<VideoCompletion>();
    await expect(writeVideoStoryboard({ ...request, sources: [request.sources[0]!, request.sources[0]!] },
      complete)).rejects.toThrow(/duplicate video source/i);
    await expect(writeVideoStoryboard({ ...request, sources: [{ ...request.sources[0]!, asOf: "2026-02-31" }] },
      complete)).rejects.toThrow(/invalid or duplicate video source/i);
    expect(complete).not.toHaveBeenCalled();
  });
});
