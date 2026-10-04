import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { AgentJobRow } from "../../queue.js";
import { MOTION_PRESET_PLACEHOLDER, serializeShot } from "../brief/shots.js";
import { ZOOM_IN_MOTION_ID } from "./motions.js";
import { runVideoBuildJob } from "./index.js";

const saved = {
  key: process.env.HIGGSFIELD_API_KEY,
  secret: process.env.HIGGSFIELD_API_SECRET,
  draft: process.env.HIGGSFIELD_MODEL_DRAFT,
  final: process.env.HIGGSFIELD_MODEL_FINAL,
};

afterEach(() => {
  if (saved.key === undefined) delete process.env.HIGGSFIELD_API_KEY;
  else process.env.HIGGSFIELD_API_KEY = saved.key;
  if (saved.secret === undefined) delete process.env.HIGGSFIELD_API_SECRET;
  else process.env.HIGGSFIELD_API_SECRET = saved.secret;
  if (saved.draft === undefined) delete process.env.HIGGSFIELD_MODEL_DRAFT;
  else process.env.HIGGSFIELD_MODEL_DRAFT = saved.draft;
  if (saved.final === undefined) delete process.env.HIGGSFIELD_MODEL_FINAL;
  else process.env.HIGGSFIELD_MODEL_FINAL = saved.final;
  vi.restoreAllMocks();
});

function setHiggsfieldEnv(): void {
  process.env.HIGGSFIELD_API_KEY = "not-a-real-key";
  process.env.HIGGSFIELD_API_SECRET = "not-a-real-secret";
  process.env.HIGGSFIELD_MODEL_DRAFT = "higgsfield-ai/dop/lite";
  process.env.HIGGSFIELD_MODEL_FINAL = "higgsfield-ai/dop/standard";
}

function clearHiggsfieldEnv(): void {
  delete process.env.HIGGSFIELD_API_KEY;
  delete process.env.HIGGSFIELD_API_SECRET;
  delete process.env.HIGGSFIELD_MODEL_DRAFT;
  delete process.env.HIGGSFIELD_MODEL_FINAL;
}

function shotLine(beat: string): string {
  return serializeShot({
    beat,
    duration_sec: 3,
    shot_source_kind: "ai_generated",
    motion_preset: MOTION_PRESET_PLACEHOLDER,
  });
}

function harness(
  brief: Record<string, unknown> | null,
  options: {
    stillsThrows?: boolean;
    assets?: { id: string }[];
    frames?: Array<{
      id: string;
      position: number;
      storage_path: string | null;
      provider_job_id: string | null;
      clip_path?: string | null;
    }>;
    signedUrl?: string | null;
    scheduleFails?: boolean;
  } = {},
) {
  const events: Array<Record<string, unknown>> = [];
  const frameUpdates: Array<Record<string, unknown>> = [];
  const briefUpdates: Array<Record<string, unknown>> = [];
  const uploads: Array<{ bucket: string; path: string; upsert: boolean; contentType: string; bytes: Buffer }> = [];
  const assets = options.assets ?? [];
  const frames = options.frames ?? [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const sb = {
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      return { data: "follow-up-job", error: options.scheduleFails ? null : null };
    },
    from(table: string) {
      if (table === "client_briefs") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: brief, error: null }),
            }),
          }),
          update: (row: Record<string, unknown>) => ({
            eq: async () => {
              briefUpdates.push(row);
              return { error: null };
            },
          }),
        };
      }
      if (table === "client_media_assets") {
        // stillsOnFile awaits .eq() directly; framesForBrief continues
        // .order().limit() off it to take only the newest build. The same
        // object has to serve both, so it is thenable and chainable.
        // Honours .limit() for real, so a test asserting "only the newest
        // build is animated" measures the query rather than the fixture.
        let take: number | null = null;
        const assetQuery: Record<string, unknown> = {};
        const settle = async () => {
          if (options.stillsThrows) throw new Error("stills lookup failed");
          return { data: take === null ? assets : assets.slice(0, take), error: null };
        };
        assetQuery.order = () => assetQuery;
        assetQuery.limit = (n: number) => {
          take = n;
          return assetQuery;
        };
        assetQuery.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
          settle().then(resolve, reject);
        return { select: () => ({ eq: () => assetQuery }) };
      }
      if (table === "client_media_frames") {
        return {
          select: () => ({
            // Filters by asset_id, so frames belonging to a superseded build
            // are not handed back just because the fixture holds them.
            eq: async (_column: string, assetId: string) => ({
              data: frames.filter((f) => (f as { asset_id?: string }).asset_id === undefined
                || (f as { asset_id?: string }).asset_id === assetId),
              error: null,
            }),
            in: async () => ({ data: frames, error: null }),
          }),
          update: (row: Record<string, unknown>) => ({
            eq: async () => {
              frameUpdates.push(row);
              return { error: null };
            },
          }),
        };
      }
      if (table === "agent_job_events") {
        return {
          insert: async (row: Record<string, unknown>) => {
            events.push(row);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    storage: {
      from: (bucket: string) => ({
        // A configured URL is returned verbatim, as the existing tests expect.
        // Without one, the path is echoed back, so a test can tell which
        // build's still was actually submitted rather than only how many.
        createSignedUrl: async (path: string) => ({
          data: options.signedUrl
            ? { signedUrl: options.signedUrl }
            : options.signedUrl === null
              ? null
              : { signedUrl: `https://cdn.example.test/${path}` },
          error: options.signedUrl === null ? { message: "no url" } : null,
        }),
        upload: async (path: string, bytes: Buffer, init: { contentType: string; upsert: boolean }) => {
          uploads.push({ bucket, path, bytes, upsert: init.upsert, contentType: init.contentType });
          return { error: null };
        },
        remove: async () => ({ error: null }),
      }),
    },
  };
  return { sb: sb as unknown as SupabaseClient, events, frameUpdates, briefUpdates, uploads, rpcCalls };
}

const job: AgentJobRow = {
  id: "job-1",
  agent_key: "video_build",
  client_id: "client-1",
  input_table: "client_briefs",
  input_id: "brief-1",
  params: null,
  status: "running",
  attempts: 1,
  max_attempts: 3,
  lease_owner: "worker",
  lease_until: null,
};

const agent = { agent_key: "video_build", name: "Video Build" } as AgentRow;
const runtime = {} as RuntimeConfig;

const reel = {
  id: "brief-1",
  client_id: "client-1",
  title: "How the mechanism works",
  media_type: "video",
  content_format: "reel",
  format_code: "F6",
  frame_plan: [shotLine("Name the mechanism"), shotLine("Show the step")],
};

describe("video_build", () => {
  it("refuses motion without Higgsfield credentials and does not call the network", async () => {
    clearHiggsfieldEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled"));
    const { sb, events, briefUpdates } = harness(reel);

    const result = await runVideoBuildJob(sb, runtime, agent, job);

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.failureMessage).toMatch(/HIGGSFIELD_API_KEY/);
    expect(result.failureMessage).toMatch(/HIGGSFIELD_API_SECRET/);
    expect(result.failureMessage).toMatch(/HIGGSFIELD_MODEL_DRAFT/);
    expect(result.failureMessage).toMatch(/No Higgsfield request was sent/);
    expect(fetchSpy).not.toHaveBeenCalled();
    const motion = events.find((event) => {
      const payload = event.payload as { creative_stage?: string } | undefined;
      return payload?.creative_stage === "motion";
    });
    expect(motion?.level).toBe("warn");
    expect(motion?.description).toMatch(/Motion paused/);
    const payload = motion?.payload as { higgsfield_called?: boolean; status?: string };
    expect(payload.higgsfield_called).toBe(false);
    expect(payload.status).toBe("paused");
    const saved = briefUpdates[0]?.frame_plan as string[];
    expect(JSON.parse(saved[0] ?? "").motion_preset).toBe(ZOOM_IN_MOTION_ID);
    expect(JSON.parse(saved[1] ?? "").motion_preset).toBe(ZOOM_IN_MOTION_ID);
    expect(saved.join(" ")).not.toContain(`"${MOTION_PRESET_PLACEHOLDER}"`);
  });

  it("still makes no request when credentials are present but opening stills are not", async () => {
    setHiggsfieldEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled"));
    const { sb } = harness(reel);

    const result = await runVideoBuildJob(sb, runtime, agent, job);

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.failureMessage).toMatch(/opening stills are not ready/);
    expect(result.failureMessage).toMatch(/No Higgsfield request was sent/);
    expect(result.failureMessage).not.toContain("not-a-real-secret");
    expect(result.failureMessage).not.toMatch(/adapter_not_enabled/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not call Higgsfield when the model ids are missing", async () => {
    process.env.HIGGSFIELD_API_KEY = "not-a-real-key";
    process.env.HIGGSFIELD_API_SECRET = "not-a-real-secret";
    delete process.env.HIGGSFIELD_MODEL_DRAFT;
    delete process.env.HIGGSFIELD_MODEL_FINAL;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled"));
    const { sb } = harness(reel);

    const result = await runVideoBuildJob(sb, runtime, agent, job);

    expect(result.ok).toBe(false);
    expect(result.failureMessage).toMatch(/HIGGSFIELD_MODEL_DRAFT/);
    expect(result.failureMessage).not.toContain("not-a-real-secret");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("schedules a collection instead of failing while Higgsfield renders", async () => {
    // The orphaning bug. Waiting used to be a retryable failure, so the queue
    // retried three times in about a minute, ran out of attempts mid-render,
    // and left six paid clips with nothing that would ever fetch them.
    setHiggsfieldEnv();
    const motion = "11111111-1111-4111-8111-111111111111";
    const ready = {
      ...reel,
      frame_plan: [
        shotLine("Name the mechanism").replace('"pending"', `"${motion}"`),
        shotLine("Show the step").replace('"pending"', `"${motion}"`),
      ],
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({ request_id: "req_abc12345", status: "queued", status_url: "https://platform.higgsfield.ai/requests/req_abc12345/status" }),
          { status: 200 },
        );
      }
      // Never finishes within this run.
      return new Response(JSON.stringify({ status: "in_progress" }), { status: 200 });
    });

    const { sb, rpcCalls } = harness(ready, {
      assets: [{ id: "asset-1" }],
      frames: [
        { id: "frame-1", position: 1, storage_path: "client-1/generated/r/01.png", provider_job_id: null },
        { id: "frame-2", position: 2, storage_path: "client-1/generated/r/02.png", provider_job_id: null },
      ],
    });
    const result = await runVideoBuildJob(sb, {} as RuntimeConfig, {} as AgentRow, job);

    // The job succeeds: the work is in flight, not broken.
    expect(result.ok).toBe(true);
    const scheduled = rpcCalls.find((call) => call.name === "schedule_agent_follow_up");
    expect(scheduled).toBeTruthy();
    expect(scheduled!.args).toMatchObject({
      p_agent_key: "video_build",
      p_input_table: "client_briefs",
    });
    expect(Number(scheduled!.args.p_after_seconds)).toBeGreaterThan(0);
  });

  it("animates only the newest build when a brief has been rebuilt", async () => {
    // The bug this exists for: a brief built three times files three assets,
    // each with positions 1..n, and reading every asset's frames turned into
    // three Higgsfield submissions per shot — triple the cost, two thirds of
    // them stills that had already been superseded.
    setHiggsfieldEnv();
    const motion = "11111111-1111-4111-8111-111111111111";
    const ready = {
      ...reel,
      frame_plan: [
        shotLine("Name the mechanism").replace('"pending"', `"${motion}"`),
        shotLine("Show the step").replace('"pending"', `"${motion}"`),
      ],
    };
    const posts: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.endsWith(".mp4")) {
        return new Response(Uint8Array.from([1]), { status: 200, headers: { "content-type": "video/mp4" } });
      }
      if (init?.method === "POST") {
        posts.push(String(init.body));
        return new Response(
          JSON.stringify({ request_id: "req_abc12345", status: "queued", status_url: "https://platform.higgsfield.ai/requests/req_abc12345/status" }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ status: "completed", video: { url: "https://cdn.example.test/c.mp4" } }), { status: 200 });
    });

    const { sb } = harness(ready, {
      // Newest first, the order the query asks for.
      assets: [{ id: "asset-new" }, { id: "asset-old" }],
      frames: [
        { id: "f-new-1", position: 1, storage_path: "client-1/generated/new/01.png", provider_job_id: null, asset_id: "asset-new" },
        { id: "f-new-2", position: 2, storage_path: "client-1/generated/new/02.png", provider_job_id: null, asset_id: "asset-new" },
        { id: "f-old-1", position: 1, storage_path: "client-1/generated/old/01.png", provider_job_id: null, asset_id: "asset-old" },
        { id: "f-old-2", position: 2, storage_path: "client-1/generated/old/02.png", provider_job_id: null, asset_id: "asset-old" },
      ] as never,
    });
    await runVideoBuildJob(sb, {} as RuntimeConfig, {} as AgentRow, job);

    // Two shots, two submissions. Not four.
    expect(posts).toHaveLength(2);
    expect(posts.join(" ")).not.toContain("/old/");
  });

  it("submits and polls through the mock when stills and a catalog motion are ready", async () => {
    setHiggsfieldEnv();
    const motion = "11111111-1111-4111-8111-111111111111";
    const ready = {
      ...reel,
      frame_plan: [shotLine("Name the mechanism").replace('"pending"', `"${motion}"`), shotLine("Show the step").replace('"pending"', `"${motion}"`)],
    };
    const clipUrl = "https://cdn.example.test/clip.mp4";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href === clipUrl) {
        return new Response(Uint8Array.from([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        });
      }
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({ request_id: "req_abc12345", status: "queued", status_url: "https://platform.higgsfield.ai/requests/req_abc12345/status" }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ status: "completed", video: { url: clipUrl } }), {
        status: 200,
      });
    });
    const { sb, frameUpdates, uploads } = harness(ready, {
      assets: [{ id: "asset-1" }],
      frames: [
        { id: "frame-1", position: 1, storage_path: "client-1/generated/r/01.png", provider_job_id: null },
        { id: "frame-2", position: 2, storage_path: "client-1/generated/r/02.png", provider_job_id: null },
      ],
      signedUrl: "https://cdn.example.test/still.png",
    });

    const result = await runVideoBuildJob(sb, runtime, agent, job);

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalled();
    const apiCalls = fetchSpy.mock.calls.filter((call) => String(call[0]) !== clipUrl);
    expect(apiCalls.length).toBeGreaterThan(0);
    for (const call of apiCalls) {
      expect(String(call[0])).toMatch(/^https:\/\/platform\.higgsfield\.ai\//);
    }
    expect(fetchSpy.mock.calls.filter((call) => String(call[0]) === clipUrl)).toHaveLength(2);
    const post = fetchSpy.mock.calls.find((call) => call[1]?.method === "POST");
    const body = JSON.parse(String(post?.[1]?.body));
    expect(body.prompt).toBe("Name the mechanism");
    expect(body.image_url).toBe("https://cdn.example.test/still.png");
    expect(body.motions).toEqual([{ id: motion, strength: 1 }]);
    expect(frameUpdates.map((row) => row.provider_job_id).filter(Boolean)).toEqual(["req_abc12345", "req_abc12345"]);
    expect(frameUpdates.map((row) => row.clip_path).filter(Boolean)).toEqual([
      "client-1/generated/clips/frame-1.mp4",
      "client-1/generated/clips/frame-2.mp4",
    ]);
    expect(uploads.map((upload) => ({ path: upload.path, upsert: upload.upsert, contentType: upload.contentType }))).toEqual([
      { path: "client-1/generated/clips/frame-1.mp4", upsert: false, contentType: "video/mp4" },
      { path: "client-1/generated/clips/frame-2.mp4", upsert: false, contentType: "video/mp4" },
    ]);
    expect(JSON.stringify(result)).not.toContain("not-a-real-secret");
  });

  it("pauses an unknown motion name and does not invent a catalog id", async () => {
    setHiggsfieldEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled"));
    const orbit = {
      ...reel,
      frame_plan: [
        serializeShot({
          beat: "Drift",
          duration_sec: 3,
          shot_source_kind: "ai_generated",
          motion_preset: "Orbit",
        }),
        serializeShot({
          beat: "Hold",
          duration_sec: 3,
          shot_source_kind: "ai_generated",
          motion_preset: "Orbit",
        }),
      ],
    };
    const { sb, uploads } = harness(orbit, {
      assets: [{ id: "asset-1" }],
      frames: [
        { id: "frame-1", position: 1, storage_path: "client-1/generated/r/01.png", provider_job_id: null },
        { id: "frame-2", position: 2, storage_path: "client-1/generated/r/02.png", provider_job_id: null },
      ],
      signedUrl: "https://cdn.example.test/still.png",
    });

    const result = await runVideoBuildJob(sb, runtime, agent, job);

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.failureMessage).toContain("Orbit");
    expect(result.failureMessage).toMatch(/No Higgsfield request was sent/);
    expect(result.failureMessage).not.toContain(ZOOM_IN_MOTION_ID);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(uploads).toEqual([]);
  });

  it("does not throw when the stills lookup fails on the way to the pause", async () => {
    clearHiggsfieldEnv();
    const { sb } = harness(reel, { stillsThrows: true });

    await expect(runVideoBuildJob(sb, runtime, agent, job)).resolves.toMatchObject({
      ok: false,
      retryable: false,
    });
  });

  it("refuses a brief that is not a reel before looking at credentials", async () => {
    clearHiggsfieldEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled"));
    const { sb, events } = harness({ ...reel, content_format: "carousel", format_code: null, frame_plan: ["a", "b"] });

    const result = await runVideoBuildJob(sb, runtime, agent, job);

    expect(result.ok).toBe(false);
    expect(result.failureMessage).toMatch(/not one/);
    expect(events).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
