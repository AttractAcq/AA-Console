import { renderStillOnLambda } from "@remotion/lambda/client";
import type { AwsRegion } from "@remotion/lambda";
import { parseRuntimeIR } from "../validate.js";
import type { SceneTiming } from "../audio/timing.js";
import type { VideoAspect } from "./probe.js";

const FPS = 30;
const TRANSITION_FRAMES = 18;
const MAX_JPEG_BYTES = 4 * 1024 * 1024;
type Still = typeof renderStillOnLambda;
type Download = typeof fetch;
type Scene = ReturnType<typeof parseRuntimeIR>["scenes"][number] & {
  minDurationSec?: number;
};
export type PreRenderFrame = { sceneId: string; frame: number;
  jpeg: Buffer; costUsd: number; renderId: string };

async function boundedJpeg(response: Response, expectedBytes: number): Promise<Buffer> {
  if (!response.ok || !response.body) {
    throw new Error("Pre-render still could not be retrieved.");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > expectedBytes || length > MAX_JPEG_BYTES) {
        throw new Error("Pre-render still exceeds its provider byte receipt.");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== expectedBytes
    || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
    throw new Error("Pre-render still bytes differ from the provider result.");
  }
  return bytes;
}

/** Mirror the renderer's scene start and duration arithmetic. A mismatch in
 * the IR/timing contract must fail before any paid still request.
 */
export function preRenderFramePoints(rawIR: unknown,
  timings: { scenes: SceneTiming[] }, aspect: VideoAspect):
  Array<{ sceneId: string; frame: number }> {
  const ir = parseRuntimeIR(rawIR);
  if (!ir.aspects.includes(aspect) || timings.scenes.length !== ir.scenes.length) {
    throw new Error("Pre-render stills require the exact requested aspect and timing set.");
  }
  let nextFrame = 0;
  const points: Array<{ sceneId: string; frame: number }> = [];
  ir.scenes.forEach((raw, index) => {
    const scene = raw as Scene;
    const timing = timings.scenes[index];
    if (!timing || scene.id !== timing.id
      || !Number.isFinite(timing.durationSec)
      || timing.durationSec <= 0 || timing.durationSec > 25) {
      throw new Error("Pre-render scene timing differs from the exact IR.");
    }
    const duration = Math.max(Math.ceil(timing.durationSec * FPS),
      Math.ceil((scene.minDurationSec ?? 2) * FPS));
    if (duration > 25 * FPS) {
      throw new Error("Pre-render scene exceeds the renderer duration limit.");
    }
    if (index > 0 && scene.transitionIn !== "cut") {
      nextFrame -= TRANSITION_FRAMES;
    }
    const start = nextFrame;
    points.push({ sceneId: scene.id, frame: start + 6 },
      { sceneId: scene.id, frame: start + Math.floor(duration / 2) },
      { sceneId: scene.id, frame: start + duration - 6 });
    nextFrame += duration;
  });
  return points;
}

/** Fetch only provider-returned private JPEGs. This transport deliberately
 * does not claim or retry paid still work: the caller must first acquire and
 * persist one exact-version review attempt, then file its cost and outcome.
 */
export async function renderPreRenderStills(input: {
  region: AwsRegion; functionName: string; serveUrl: string;
  aspect: VideoAspect; ir: unknown;
  timings: { scenes: SceneTiming[] }; projectId: string;
  irVersion: number; attemptId: string;
}, deps: { still: Still; download: Download } = {
  still: renderStillOnLambda, download: fetch,
}): Promise<PreRenderFrame[]> {
  const points = preRenderFramePoints(input.ir, input.timings, input.aspect);
  if (!input.functionName || !input.serveUrl.startsWith("https://")
    || !/^[0-9a-f-]{36}$/i.test(input.projectId)
    || !/^[0-9a-f-]{36}$/i.test(input.attemptId)
    || !Number.isInteger(input.irVersion) || input.irVersion < 1) {
    throw new Error("Pre-render still request lacks exact deployment or attempt identity.");
  }
  const frames = new Array<PreRenderFrame>(points.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, points.length) }, async () => {
    while (next < points.length) {
      const index = next++;
      const point = points[index]!;
      const rendered = await deps.still({ region: input.region,
        functionName: input.functionName, serveUrl: input.serveUrl,
        composition: `VideoIR-${input.aspect.replace(":", "x")}`,
        inputProps: { ir: input.ir, timings: input.timings,
          aspect: input.aspect },
        frame: point.frame, imageFormat: "jpeg", privacy: "private",
        forceWidth: 640, maxRetries: 1,
        outName: `${input.projectId}-v${input.irVersion}-${input.attemptId}`
          + `-${String(index).padStart(3, "0")}.jpg`,
      });
      const url = new URL(rendered.url);
      const price = rendered.estimatedPrice;
      if (url.protocol !== "https:" || !url.hostname
        || url.username || url.password
        || rendered.sizeInBytes < 100
        || rendered.sizeInBytes > MAX_JPEG_BYTES
        || !rendered.renderId
        || price.currency !== "USD"
        || !Number.isFinite(price.accruedSoFar)
        || price.accruedSoFar < 0) {
        throw new Error("Pre-render still has invalid provider evidence.");
      }
      const response = await deps.download(url.toString(),
        { signal: AbortSignal.timeout(90_000) });
      const bytes = await boundedJpeg(response, rendered.sizeInBytes);
      frames[index] = { ...point, jpeg: bytes,
        costUsd: price.accruedSoFar, renderId: rendered.renderId };
    }
  }));
  return frames;
}
