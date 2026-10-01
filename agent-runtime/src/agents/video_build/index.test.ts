import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { AgentJobRow } from "../../queue.js";
import { MOTION_PRESET_PLACEHOLDER, serializeShot } from "../brief/shots.js";
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
    }>;
    signedUrl?: string | null;
  } = {},
) {
  const events: Array<Record<string, unknown>> = [];
  const frameUpdates: Array<Record<string, unknown>> = [];
  const assets = options.assets ?? [];
  const frames = options.frames ?? [];
  const sb = {
    from(table: string) {
      if (table === "client_briefs") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: brief, error: null }),
            }),
          }),
        };
      }
      if (table === "client_media_assets") {
        return {
          select: () => ({
            eq: async () => {
              if (options.stillsThrows) throw new Error("stills lookup failed");
              return { data: assets, error: null };
            },
          }),
        };
      }
      if (table === "client_media_frames") {
        return {
          select: () => ({
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
      from: () => ({
        createSignedUrl: async () => ({
          data: options.signedUrl ? { signedUrl: options.signedUrl } : null,
          error: options.signedUrl ? null : { message: "no url" },
        }),
      }),
    },
  };
  return { sb: sb as unknown as SupabaseClient, events, frameUpdates };
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
    const { sb, events } = harness(reel);

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

  it("submits and polls through the mock when stills and a catalog motion are ready", async () => {
    setHiggsfieldEnv();
    const motion = "11111111-1111-4111-8111-111111111111";
    const ready = {
      ...reel,
      frame_plan: [shotLine("Name the mechanism").replace('"pending"', `"${motion}"`), shotLine("Show the step").replace('"pending"', `"${motion}"`)],
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({ request_id: "req_abc12345", status: "queued", status_url: "https://platform.higgsfield.ai/requests/req_abc12345/status" }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ status: "completed", video: { url: "https://cdn.example.test/clip.mp4" } }), {
        status: 200,
      });
    });
    const { sb, frameUpdates } = harness(ready, {
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
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).toMatch(/^https:\/\/platform\.higgsfield\.ai\//);
    }
    const post = fetchSpy.mock.calls.find((call) => call[1]?.method === "POST");
    const body = JSON.parse(String(post?.[1]?.body));
    expect(body.prompt).toBe("Name the mechanism");
    expect(body.image_url).toBe("https://cdn.example.test/still.png");
    expect(body.motions).toEqual([{ id: motion, strength: 1 }]);
    expect(frameUpdates.map((row) => row.provider_job_id)).toEqual(["req_abc12345", "req_abc12345"]);
    expect(JSON.stringify(result)).not.toContain("not-a-real-secret");
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
