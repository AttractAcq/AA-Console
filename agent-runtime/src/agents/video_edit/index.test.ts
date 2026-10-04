import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { AgentJobRow } from "../../queue.js";
import { runVideoEditJob } from "./index.js";

const REEL = {
  id: "asset-1",
  client_id: "client-1",
  brief_id: "brief-1",
  title: "The Chain",
  media_type: "video",
  content_format: "reel",
};

const BRIEF = {
  id: "brief-1",
  title: "The Chain",
  media_type: "video",
  content_format: "reel",
  format_code: "F7",
  frame_plan: [
    JSON.stringify({ beat: "Cold open", duration_sec: 4, shot_source_kind: "ai_generated", motion_preset: "pending" }),
    JSON.stringify({ beat: "The mechanism", duration_sec: 4, shot_source_kind: "ai_generated", motion_preset: "pending" }),
  ],
  hook: "Thirty posts last month. Nothing in the diary.",
  script: null,
  call_to_action: null,
  proof: null,
  channel_intent: null,
};

const frame = (position: number, clip: string | null, provider: string | null = null) => ({
  id: `frame-${position}`,
  position,
  beat: position === 1 ? "Cold open" : "The mechanism",
  duration_sec: 4,
  shot_source_kind: "ai_generated",
  clip_path: clip,
  provider_job_id: provider,
});

function harness(options: {
  asset?: Record<string, unknown> | null;
  brief?: Record<string, unknown> | null;
  frames?: Array<Record<string, unknown>>;
} = {}) {
  const events: Array<Record<string, unknown>> = [];
  const asset = options.asset === undefined ? REEL : options.asset;
  const brief = options.brief === undefined ? BRIEF : options.brief;
  const frames = options.frames ?? [];
  const sb = {
    from(table: string) {
      if (table === "agent_job_events") {
        return { insert: async (row: Record<string, unknown>) => { events.push(row); return { error: null }; } };
      }
      if (table === "client_media_assets") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: asset, error: null }) }) }) };
      }
      if (table === "client_briefs") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: brief, error: null }) }) }) };
      }
      if (table === "client_media_frames") {
        return { select: () => ({ eq: () => ({ order: async () => ({ data: frames, error: null }) }) }) };
      }
      if (table === "client_brand_profiles") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
  return { sb, events };
}

const job = (over: Partial<AgentJobRow> = {}) =>
  ({ id: "job-1", client_id: "client-1", input_table: "client_media_assets", input_id: "asset-1", ...over }) as AgentJobRow;

const run = (sb: SupabaseClient, j: AgentJobRow = job()) =>
  runVideoEditJob(sb, { model: "claude-opus-5" } as RuntimeConfig, {} as AgentRow, j);

describe("the cut refuses before it spends anything", () => {
  it("needs a client", async () => {
    const { sb } = harness();
    expect(await run(sb, job({ client_id: null }))).toMatchObject({ ok: false, retryable: false });
  });

  it("needs the reel asset, not a brief", async () => {
    const { sb } = harness();
    const result = await run(sb, job({ input_table: "client_briefs" }));
    expect(result.failureMessage).toMatch(/needs the reel asset/);
  });

  it("refuses anything that is not a reel", async () => {
    const { sb } = harness({ asset: { ...REEL, content_format: "carousel", media_type: "image" } });
    expect((await run(sb)).failureMessage).toMatch(/Only a reel is cut here/);
  });

  it("refuses a reel with no brief to cut against", async () => {
    const { sb } = harness({ asset: { ...REEL, brief_id: null } });
    expect((await run(sb)).failureMessage).toMatch(/no brief/);
  });
});

describe("the readiness gate, which is where every run stops today", () => {
  it("says the clips have not landed, and which shots are waiting", async () => {
    // Motion is paused until the Higgsfield env is set, so clip_path is null
    // on every shot. This is the real state of production right now.
    const { sb, events } = harness({ frames: [frame(1, null), frame(2, null)] });
    const result = await run(sb);

    expect(result.ok).toBe(false);
    // Not retryable: a retry cannot make a clip appear, and three attempts at
    // the same answer is three lies about having tried something.
    expect(result.retryable).toBe(false);
    expect(result.failureMessage).toBeTruthy();

    const warned = events.find((e) => e.level === "warn");
    expect(warned).toBeTruthy();
    expect((warned!.payload as Record<string, unknown>).reason).toBe("clips_missing");
  });

  it("tells a shot still rendering apart from one never submitted", async () => {
    const submitted = harness({ frames: [frame(1, null, "hf-request-1"), frame(2, null)] });
    const never = harness({ frames: [frame(1, null), frame(2, null)] });
    const a = await run(submitted.sb);
    const b = await run(never.sb);
    // Both block, but the operator is told different things: one is waiting
    // on Higgsfield, the other was never sent.
    expect(a.failureMessage).not.toBe(b.failureMessage);
  });

  it("refuses a reel with no shot plan rather than inventing one", async () => {
    const { sb, events } = harness({ brief: { ...BRIEF, frame_plan: null }, frames: [frame(1, "a.mp4")] });
    const result = await run(sb);
    expect(result.ok).toBe(false);
    const warned = events.find((e) => e.level === "warn");
    expect((warned!.payload as Record<string, unknown>).reason).toBe("no_shot_plan");
  });

  it("records the reason on the job, not only in the failure message", async () => {
    // The failure message reaches the dashboard; the payload is what a later
    // query can count. Both, or the reason is only readable by a person.
    const { sb, events } = harness({ frames: [frame(1, null), frame(2, null)] });
    await run(sb);
    const warned = events.find((e) => e.level === "warn")!;
    expect(warned.job_id).toBe("job-1");
    expect(warned.payload).toMatchObject({ stage: "readiness" });
  });
});
