import { downloadMedia } from "@remotion/lambda";
import { getRenderProgress, renderMediaOnLambda } from "@remotion/lambda/client";
import type { AwsRegion } from "@remotion/lambda";

export type LambdaRenderHandle = { region: AwsRegion; functionName: string;
  renderId: string; bucketName: string; outName: string };
type Progress = Awaited<ReturnType<typeof getRenderProgress>>;
type Transport = { start: typeof renderMediaOnLambda;
  progress: typeof getRenderProgress; download: typeof downloadMedia;
  sleep: (ms: number) => Promise<void>; now: () => number };
const transport: Transport = { start: renderMediaOnLambda,
  progress: getRenderProgress, download: downloadMedia,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now };

export class LambdaRenderObservationError extends Error {
  constructor(message: string, readonly handle: LambdaRenderHandle) {
    super(message);
  }
}

export class LambdaRenderStartUnknownError extends Error {
  constructor() {
    super("Lambda start returned no handle; inspect the provider before retrying.");
  }
}

function validateHandle(handle: LambdaRenderHandle): void {
  if (!handle.region || !handle.functionName
    || !/^[a-zA-Z0-9-]+$/.test(handle.renderId)
    || !/^[a-z0-9.-]+$/.test(handle.bucketName)
    || !/^[a-zA-Z0-9_.-]+\.mp4$/.test(handle.outName)) {
    throw new Error("Lambda render handle is invalid.");
  }
}

/** Observe one already-started render. A polling timeout or transient read
 * failure never starts another render; the caller can resume this handle.
 */
export async function resumeLambdaRender(input: {
  handle: LambdaRenderHandle; localPath: string;
  onProgress?: (progress: Progress) => Promise<void>;
  deadlineMs?: number; pollIntervalMs?: number;
}, deps: Transport = transport): Promise<{ outputPath: string;
  sizeInBytes: number; progress: Progress }> {
  const { handle } = input;
  validateHandle(handle);
  if (!input.localPath || !Number.isFinite(input.deadlineMs ?? 45 * 60_000)
    || (input.deadlineMs ?? 45 * 60_000) <= 0) {
    throw new Error("Lambda render observation settings are invalid.");
  }
  const deadline = deps.now() + (input.deadlineMs ?? 45 * 60_000);
  const interval = input.pollIntervalMs ?? 5000;
  if (!Number.isFinite(interval) || interval < 0) {
    throw new Error("Lambda render poll interval is invalid.");
  }
  while (deps.now() < deadline) {
    let progress: Progress;
    try {
      progress = await deps.progress({ region: handle.region,
        functionName: handle.functionName, renderId: handle.renderId,
        bucketName: handle.bucketName, skipLambdaInvocation: true });
    } catch {
      // Keep observing the same handle after a transient progress/read error.
      await deps.sleep(interval);
      continue;
    }
    await input.onProgress?.(progress);
    if (progress.fatalErrorEncountered) {
      throw new LambdaRenderObservationError(
        "Lambda render failed; inspect the recorded render handle and errors.", handle);
    }
    if (progress.done) {
      if (!progress.outputFile) {
        throw new LambdaRenderObservationError(
          "Lambda render finished without an output file.", handle);
      }
      let downloaded: Awaited<ReturnType<typeof downloadMedia>>;
      try {
        downloaded = await deps.download({ region: handle.region,
          renderId: handle.renderId, bucketName: handle.bucketName,
          outPath: input.localPath });
      } catch {
        throw new LambdaRenderObservationError(
          "Lambda render finished but download failed; resume the handle.", handle);
      }
      if (downloaded.sizeInBytes <= 0
        || downloaded.outputPath !== input.localPath) {
        throw new LambdaRenderObservationError(
          "Lambda render download has no verified local file.", handle);
      }
      return { ...downloaded, progress };
    }
    await deps.sleep(interval);
  }
  throw new LambdaRenderObservationError(
    "Lambda render observation timed out; resume the recorded handle.", handle);
}

/** Starting is deliberately separate from resuming. The caller must persist
 * the handle before observation and never retry a start with uncertain status.
 */
export async function startLambdaRender(input: {
  region: AwsRegion; functionName: string; serveUrl: string;
  projectId: string; aspect: "16:9" | "9:16" | "1:1";
  ir: unknown; timings: unknown;
  onStarted: (handle: LambdaRenderHandle) => Promise<void>;
}, deps: Transport = transport): Promise<LambdaRenderHandle> {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(input.functionName)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.projectId)
    || !["16:9", "9:16", "1:1"].includes(input.aspect)
    || !input.serveUrl.startsWith("https://")) {
    throw new Error("Lambda render deployment identity is incomplete.");
  }
  const outName = `${input.projectId}-${input.aspect.replace(":", "x")}.mp4`;
  let started: Awaited<ReturnType<typeof renderMediaOnLambda>>;
  try {
    started = await deps.start({ region: input.region,
    functionName: input.functionName, serveUrl: input.serveUrl,
    composition: `VideoIR-${input.aspect.replace(":", "x")}`,
    inputProps: { ir: input.ir, timings: input.timings, aspect: input.aspect },
    codec: "h264", crf: 18, audioCodec: "aac", audioBitrate: "192k",
    framesPerLambda: 60, privacy: "private", outName,
    maxRetries: 1, logLevel: "error" });
  } catch {
    throw new LambdaRenderStartUnknownError();
  }
  const handle = { region: input.region, functionName: input.functionName,
    renderId: started.renderId, bucketName: started.bucketName, outName };
  validateHandle(handle);
  try { await input.onStarted(handle); }
  catch {
    throw new LambdaRenderObservationError(
      "Lambda started but its handle was not persisted; reconcile before retry.", handle);
  }
  return handle;
}
