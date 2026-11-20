import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { preRenderFramePoints, renderPreRenderStills } from "./prerender-stills.js";

const ir = JSON.parse(readFileSync(resolve(import.meta.dirname,
  "../../../../video-render/fixtures/ir/three-scene-v2.json"), "utf8"));
const timings = { scenes: ir.scenes.map((scene: { id: string }) => ({
  id: scene.id, durationSec: 2, audioSrc: "https://example.test/audio.mp3",
  words: [] })) };
const projectId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(120),
  Buffer.from([0xff, 0xd9])]);
const request = { region: "eu-central-1" as const,
  functionName: "remotion-test", serveUrl: "https://site.example.test",
  aspect: "16:9" as const, ir, timings, projectId, irVersion: 1,
  attemptId, brandSnapshot: { colour_primary: "#123456" } };

describe("pre-render still sampling", () => {
  it("samples three exact frames per scene with transition overlap", () => {
    expect(preRenderFramePoints(ir, timings, "16:9"))
      .toEqual([{ sceneId: "s01", frame: 6 },
        { sceneId: "s01", frame: 30 }, { sceneId: "s01", frame: 54 },
        { sceneId: "s02", frame: 48 }, { sceneId: "s02", frame: 72 },
        { sceneId: "s02", frame: 96 },
        { sceneId: "s03", frame: 90 }, { sceneId: "s03", frame: 114 },
        { sceneId: "s03", frame: 138 }]);
    expect(() => preRenderFramePoints(ir, { scenes: timings.scenes.slice(1) },
      "16:9")).toThrow(/exact requested aspect and timing/);
  });

  it("renders private JPEGs at bounded concurrency and verifies bytes and USD", async () => {
    let active = 0;
    let maximum = 0;
    const still = vi.fn(async (params: { frame: number }) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return { url: `https://objects.example.test/${params.frame}.jpg`,
        sizeInBytes: jpeg.length, renderId: `render-${params.frame}`,
        estimatedPrice: { currency: "USD", accruedSoFar: 0.01 } };
    });
    const download = vi.fn(async () => new Response(jpeg));
    const frames = await renderPreRenderStills(request,
      { still: still as never, download: download as never });
    expect(still).toHaveBeenCalledTimes(9);
    expect(maximum).toBeLessThanOrEqual(6);
    expect(frames).toHaveLength(9);
    expect(frames[0]).toMatchObject({ sceneId: "s01", frame: 6,
      costUsd: 0.01, renderId: "render-6" });
    expect(frames.every((frame) => frame.jpeg.equals(jpeg))).toBe(true);
    expect(still.mock.calls[0]?.[0]).toMatchObject({ imageFormat: "jpeg",
      privacy: "private", forceWidth: 640,
      composition: "VideoIR-16x9",
      inputProps: expect.objectContaining({ brandSnapshot: {
        colour_primary: "#123456" } }) });
  });

  it("fails a stale timing set before provider work", async () => {
    const still = vi.fn();
    await expect(renderPreRenderStills({ ...request,
      timings: { scenes: timings.scenes.slice(1) } },
    { still: still as never, download: vi.fn() as never }))
      .rejects.toThrow(/exact requested aspect and timing/);
    expect(still).not.toHaveBeenCalled();
  });

  it("refuses malformed client brand tokens before the first paid still", async () => {
    const still = vi.fn();
    await expect(renderPreRenderStills({ ...request,
      brandSnapshot: { video_tokens: { colours: { primary: "blue" } } } },
    { still: still as never, download: vi.fn() as never }))
      .rejects.toThrow(/brand snapshot/);
    expect(still).not.toHaveBeenCalled();
  });

  it("rejects provider evidence that disagrees with retrieved JPEG bytes", async () => {
    const still = vi.fn(async () => ({ url: "https://objects.example.test/frame.jpg",
      sizeInBytes: jpeg.length + 1, renderId: "render-one",
      estimatedPrice: { currency: "USD", accruedSoFar: 0.01 } }));
    await expect(renderPreRenderStills(request,
      { still: still as never,
        download: vi.fn(async () => new Response(jpeg)) as never }))
      .rejects.toThrow(/bytes differ/);
  });
});
