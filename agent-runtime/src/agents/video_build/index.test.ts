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
};

afterEach(() => {
  if (saved.key === undefined) delete process.env.HIGGSFIELD_API_KEY;
  else process.env.HIGGSFIELD_API_KEY = saved.key;
  if (saved.secret === undefined) delete process.env.HIGGSFIELD_API_SECRET;
  else process.env.HIGGSFIELD_API_SECRET = saved.secret;
  vi.restoreAllMocks();
});

function shotLine(beat: string): string {
  return serializeShot({
    beat,
    duration_sec: 3,
    shot_source_kind: "ai_generated",
    motion_preset: MOTION_PRESET_PLACEHOLDER,
  });
}

function harness(brief: Record<string, unknown> | null, stillsThrows = false) {
  const events: Array<Record<string, unknown>> = [];
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
              if (stillsThrows) throw new Error("stills lookup failed");
              return { data: [], error: null };
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
  };
  return { sb: sb as unknown as SupabaseClient, events };
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
    delete process.env.HIGGSFIELD_API_KEY;
    delete process.env.HIGGSFIELD_API_SECRET;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled"));
    const { sb, events } = harness(reel);

    const result = await runVideoBuildJob(sb, runtime, agent, job);

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.failureMessage).toMatch(/HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET/);
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

  it("still makes no request when the credentials are present", async () => {
    process.env.HIGGSFIELD_API_KEY = "not-a-real-key";
    process.env.HIGGSFIELD_API_SECRET = "not-a-real-secret";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled"));
    const { sb } = harness(reel);

    const result = await runVideoBuildJob(sb, runtime, agent, job);

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.failureMessage).toMatch(/does not submit image-to-video/);
    expect(result.failureMessage).not.toContain("not-a-real-secret");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not throw when the stills lookup fails on the way to the pause", async () => {
    delete process.env.HIGGSFIELD_API_KEY;
    delete process.env.HIGGSFIELD_API_SECRET;
    const { sb } = harness(reel, true);

    await expect(runVideoBuildJob(sb, runtime, agent, job)).resolves.toMatchObject({
      ok: false,
      retryable: false,
    });
  });

  it("refuses a brief that is not a reel before looking at credentials", async () => {
    delete process.env.HIGGSFIELD_API_KEY;
    delete process.env.HIGGSFIELD_API_SECRET;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled"));
    const { sb, events } = harness({ ...reel, content_format: "carousel", format_code: null, frame_plan: ["a", "b"] });

    const result = await runVideoBuildJob(sb, runtime, agent, job);

    expect(result.ok).toBe(false);
    expect(result.failureMessage).toMatch(/not one/);
    expect(events).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
