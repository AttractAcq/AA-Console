import { describe, expect, it } from "vitest";
import { MOTION_PRESET_PLACEHOLDER, serializeShot, type ShotPlanEntry } from "../brief/shots.js";
import { ZOOM_IN_MOTION_ID } from "./motions.js";
import {
  decideMotion,
  motionFollowUp,
  MOTION_POLL_AFTER_SECONDS,
  prepareMotionCalls,
  readHiggsfieldEnv,
  type MotionFrameRef,
} from "./motion.js";

const shot = (beat: string, motion = MOTION_PRESET_PLACEHOLDER): ShotPlanEntry => ({
  beat,
  duration_sec: 3,
  shot_source_kind: "ai_generated",
  motion_preset: motion,
});

const MOTION = "11111111-1111-4111-8111-111111111111";

describe("motion without Higgsfield credentials", () => {
  it("pauses when the key is missing and does not throw", () => {
    expect(() =>
      decideMotion({
        apiKey: "",
        apiSecret: "present-secret",
        modelDraft: "higgsfield-ai/dop/lite",
        modelFinal: "higgsfield-ai/dop/standard",
      }),
    ).not.toThrow();
    const decision = decideMotion({
      apiKey: "   ",
      apiSecret: "present-secret",
      modelDraft: "higgsfield-ai/dop/lite",
      modelFinal: "higgsfield-ai/dop/standard",
    });
    expect(decision.proceed).toBe(false);
    expect(decision.stage).toBe("paused");
    expect(decision.retryable).toBe(false);
    expect(decision.reason).toBe("missing_higgsfield_credentials");
    expect(decision.message).toContain("HIGGSFIELD_API_KEY");
    expect(decision.message).toContain("No Higgsfield request was sent");
    expect(decision.message).not.toContain("present-secret");
  });

  it("pauses when the secret is missing", () => {
    const decision = decideMotion({
      apiKey: "present-key",
      apiSecret: "",
      modelDraft: "draft",
      modelFinal: "final",
    });
    expect(decision.proceed).toBe(false);
    expect(decision.message).toContain("HIGGSFIELD_API_SECRET");
    expect(decision.message).not.toContain("present-key");
  });

  it("names every missing variable", () => {
    const decision = decideMotion({ apiKey: undefined, apiSecret: null });
    expect(decision.message).toContain("HIGGSFIELD_API_KEY");
    expect(decision.message).toContain("HIGGSFIELD_API_SECRET");
    expect(decision.message).toContain("HIGGSFIELD_MODEL_DRAFT");
    expect(decision.message).toContain("HIGGSFIELD_MODEL_FINAL");
    expect(decision.message).toMatch(/are not set/);
  });

  it("pauses when the model ids are missing even if the key pair is set", () => {
    const decision = decideMotion({ apiKey: "key", apiSecret: "secret" });
    expect(decision.proceed).toBe(false);
    expect(decision.reason).toBe("missing_higgsfield_credentials");
    expect(decision.message).toContain("HIGGSFIELD_MODEL_DRAFT");
    expect(decision.message).toContain("HIGGSFIELD_MODEL_FINAL");
    expect(decision.message).toContain("No Higgsfield request was sent");
    expect(decision.message).not.toContain("secret");
  });

  it("proceeds when the key, the secret and both model ids are set", () => {
    const decision = decideMotion({
      apiKey: "key",
      apiSecret: "secret",
      modelDraft: "higgsfield-ai/dop/lite",
      modelFinal: "higgsfield-ai/dop/standard",
    });
    expect(decision.proceed).toBe(true);
    if (!decision.proceed) return;
    expect(decision.modelDraft).toBe("higgsfield-ai/dop/lite");
    expect(decision.modelFinal).toBe("higgsfield-ai/dop/standard");
    expect(decision.message).not.toContain("secret");
  });

  it("treats a blank env value as missing", () => {
    const env = readHiggsfieldEnv({
      HIGGSFIELD_API_KEY: "  ",
      HIGGSFIELD_API_SECRET: "s",
      HIGGSFIELD_MODEL_DRAFT: "draft",
      HIGGSFIELD_MODEL_FINAL: "final",
    });
    expect(decideMotion(env).reason).toBe("missing_higgsfield_credentials");
  });
});

describe("prepareMotionCalls", () => {
  const frames: MotionFrameRef[] = [
    { id: "frame-1", position: 1, providerJobId: null },
    { id: "frame-2", position: 2, providerJobId: null },
  ];
  const urls = new Map<number, string>([
    [1, "https://cdn.example.test/1.png"],
    [2, "https://cdn.example.test/2.png"],
  ]);

  it("submits pending and Zoom In as the Cockpit catalog id", () => {
    const plan = prepareMotionCalls({
      shots: [shot("Name it", "pending"), shot("Show it", "Zoom In")],
      frames,
      stillUrlByPosition: urls,
      modelId: "higgsfield-ai/dop/lite",
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.calls[0]).toMatchObject({ kind: "submit", motionId: ZOOM_IN_MOTION_ID });
    expect(plan.calls[1]).toMatchObject({ kind: "submit", motionId: ZOOM_IN_MOTION_ID });
    expect(JSON.stringify(plan.calls)).not.toContain(MOTION);
  });

  it("does not invent an id for an unknown motion name", () => {
    const plan = prepareMotionCalls({
      shots: [shot("Name it", "Orbit"), shot("Show it", "Orbit")],
      frames,
      stillUrlByPosition: urls,
      modelId: "higgsfield-ai/dop/lite",
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe("motion_preset_pending");
    expect(plan.message).toContain("Orbit");
    expect(plan.message).toContain("No Higgsfield request was sent");
    expect(plan.message).not.toContain(ZOOM_IN_MOTION_ID);
    expect(plan.message).not.toContain(MOTION);
  });

  it("does not submit without an https still", () => {
    const plan = prepareMotionCalls({
      shots: [shot("Name it", MOTION), shot("Show it", MOTION)],
      frames,
      stillUrlByPosition: new Map(),
      modelId: "higgsfield-ai/dop/lite",
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe("stills_not_ready");
    expect(plan.message).toContain("No Higgsfield request was sent");
  });

  it("submits every ready shot and does not invent an end frame", () => {
    const plan = prepareMotionCalls({
      shots: [shot("Name it", MOTION), shot("Show it", MOTION)],
      frames,
      stillUrlByPosition: urls,
      modelId: "higgsfield-ai/dop/lite",
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.calls).toHaveLength(2);
    expect(plan.calls[0]).toMatchObject({
      kind: "submit",
      position: 1,
      prompt: "Name it",
      imageUrl: "https://cdn.example.test/1.png",
      motionId: MOTION,
      strength: 1,
      modelId: "higgsfield-ai/dop/lite",
    });
  });

  it("polls a shot that already has a request id instead of submitting it again", () => {
    const plan = prepareMotionCalls({
      shots: [shot("Name it", MOTION), shot("Show it", MOTION)],
      frames: [
        { id: "frame-1", position: 1, providerJobId: "req_already" },
        { id: "frame-2", position: 2, providerJobId: null },
      ],
      stillUrlByPosition: urls,
      modelId: "higgsfield-ai/dop/lite",
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.calls.map((call) => call.kind)).toEqual(["poll", "submit"]);
  });

  it("drops new submits when another shot is blocked, and still polls what was stored", () => {
    const plan = prepareMotionCalls({
      shots: [shot("Name it", MOTION), shot("Show it", "Orbit")],
      frames: [
        { id: "frame-1", position: 1, providerJobId: "req_already" },
        { id: "frame-2", position: 2, providerJobId: null },
      ],
      stillUrlByPosition: urls,
      modelId: "higgsfield-ai/dop/lite",
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.calls).toEqual([
      { kind: "poll", position: 1, frameId: "frame-1", requestId: "req_already" },
    ]);
  });
});

describe("motionFollowUp", () => {
  it("never reports waiting as a failure, whatever the mix of statuses", () => {
    // The specific regression: anything still in flight must come back as
    // pending, so the caller schedules a collection instead of burning an
    // attempt. Six paid clips were orphaned by the old behaviour.
    for (const statuses of [
      ["in_progress"],
      ["queued", "completed"],
      ["completed", "completed", "in_progress"],
      ["starting"],
    ]) {
      const result = motionFollowUp(statuses);
      expect(result.outcome).toBe("pending");
      expect(result).not.toHaveProperty("retryable");
    }
  });

  it("still fails hard when a shot genuinely failed, even beside a pending one", () => {
    // A failure is not something to wait for.
    expect(motionFollowUp(["in_progress", "failed"])).toMatchObject({ outcome: "failed", retryable: false });
  });

  it("waits long enough to be worth waiting, and not so long a clip sits", () => {
    expect(MOTION_POLL_AFTER_SECONDS).toBeGreaterThanOrEqual(60);
    expect(MOTION_POLL_AFTER_SECONDS).toBeLessThanOrEqual(600);
  });

  it("finishes when every shot completed", () => {
    expect(motionFollowUp(["completed", "completed"])).toMatchObject({ outcome: "completed" });
  });

  it("asks for another poll while a shot is still rendering", () => {
    // Waiting is its own outcome. It used to be a retryable failure, which
    // the queue answered by retrying three times in a minute and then giving
    // up while the clips were still rendering.
    expect(motionFollowUp(["completed", "in_progress"])).toMatchObject({
      outcome: "pending",
      pollAfterSeconds: MOTION_POLL_AFTER_SECONDS,
    });
  });

  it("does not retry a failed or nsfw shot", () => {
    expect(motionFollowUp(["nsfw"])).toMatchObject({ outcome: "failed", retryable: false });
    expect(motionFollowUp(["failed"])).toMatchObject({ outcome: "failed", retryable: false });
  });
});

describe("serializeShot stays a stored line", () => {
  it("round-trips a catalog id without turning pending into one", () => {
    const line = serializeShot(shot("Name it"));
    expect(line).toContain(MOTION_PRESET_PLACEHOLDER);
    expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
});
