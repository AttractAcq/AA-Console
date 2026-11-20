import { describe, expect, it, vi } from "vitest";
import { LambdaRenderObservationError, LambdaRenderStartUnknownError,
  resumeLambdaRender, startLambdaRender } from "./lambda.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const handle = { region: "eu-central-1" as const,
  functionName: "remotion-render-test", renderId: "render123",
  bucketName: "remotion-test-bucket", outName: `${projectId}-16x9.mp4`,
  serveUrl: "https://site.example.test" };
type Transport = NonNullable<Parameters<typeof startLambdaRender>[1]>;

function mockTransport(progressValues: Array<unknown> = []) {
  let clock = 0;
  const start = vi.fn(async () => ({ renderId: handle.renderId,
    bucketName: handle.bucketName }));
  const progress = vi.fn(async () => {
    const next = progressValues.shift();
    if (next instanceof Error) throw next;
    return next ?? { done: true, fatalErrorEncountered: false,
      outputFile: "s3://remotion-test-bucket/out.mp4" };
  });
  const download = vi.fn(async (_args: unknown) => ({
    outputPath: "/tmp/render.mp4", sizeInBytes: 1000 }));
  const sleep = vi.fn(async (ms: number) => { clock += ms; });
  const deps = { start, progress, download, sleep,
    now: () => clock } as unknown as Transport;
  return { deps, start, progress, download, sleep };
}

describe("Lambda render transport", () => {
  it("starts one private exact-aspect render and records the handle", async () => {
    const mock = mockTransport();
    const onStarted = vi.fn(async () => {});
    const result = await startLambdaRender({ region: handle.region,
      functionName: handle.functionName, serveUrl: "https://site.example.test",
      projectId, aspect: "16:9", ir: { version: 1 },
      timings: { scenes: [] }, brandSnapshot: { colour_primary: "#123456" },
      onStarted }, mock.deps);
    expect(result).toEqual(handle);
    expect(onStarted).toHaveBeenCalledWith(handle);
    expect(mock.start).toHaveBeenCalledWith(expect.objectContaining({
      composition: "VideoIR-16x9", privacy: "private", codec: "h264",
      audioCodec: "aac", audioBitrate: "192k", framesPerLambda: 60,
      outName: handle.outName,
      inputProps: expect.objectContaining({ brandSnapshot: {
        colour_primary: "#123456" } }) }));
    expect(mock.progress).not.toHaveBeenCalled();
  });

  it("resumes the same handle after a transient progress error", async () => {
    const mock = mockTransport([new Error("temporary"),
      { done: false, fatalErrorEncountered: false, outputFile: null },
      { done: true, fatalErrorEncountered: false, outputFile: "s3://result" }]);
    const result = await resumeLambdaRender({ handle,
      localPath: "/tmp/render.mp4", deadlineMs: 100,
      pollIntervalMs: 5 }, mock.deps);
    expect(result.sizeInBytes).toBe(1000);
    expect(mock.progress).toHaveBeenCalledTimes(3);
    expect(mock.download).toHaveBeenCalledTimes(1);
    expect(mock.start).not.toHaveBeenCalled();
  });

  it("keeps the handle on a fatal outcome, timeout or unpersisted start", async () => {
    const fatal = mockTransport([{ done: false, fatalErrorEncountered: true,
      outputFile: null }]);
    await expect(resumeLambdaRender({ handle, localPath: "/tmp/render.mp4" },
      fatal.deps)).rejects.toMatchObject({ handle });
    const timed = mockTransport([new Error("unavailable"),
      new Error("unavailable")]);
    await expect(resumeLambdaRender({ handle, localPath: "/tmp/render.mp4",
      deadlineMs: 5, pollIntervalMs: 5 }, timed.deps))
      .rejects.toBeInstanceOf(LambdaRenderObservationError);
    expect(timed.start).not.toHaveBeenCalled();
    const uncertain = mockTransport();
    uncertain.start.mockRejectedValueOnce(new Error("network"));
    await expect(startLambdaRender({ region: handle.region,
      functionName: handle.functionName, serveUrl: "https://site.example.test",
      projectId, aspect: "16:9", ir: {}, timings: {},
      brandSnapshot: {},
      onStarted: async () => {} }, uncertain.deps))
      .rejects.toBeInstanceOf(LambdaRenderStartUnknownError);
  });

  it("refuses an invalid brand snapshot before starting Lambda", async () => {
    const mock = mockTransport();
    await expect(startLambdaRender({ region: handle.region,
      functionName: handle.functionName, serveUrl: "https://site.example.test",
      projectId, aspect: "16:9", ir: {}, timings: {},
      brandSnapshot: { video_tokens: { colours: { primary: "blue" } } },
      onStarted: async () => {} }, mock.deps)).rejects.toThrow(/brand snapshot/);
    expect(mock.start).not.toHaveBeenCalled();
  });
});
