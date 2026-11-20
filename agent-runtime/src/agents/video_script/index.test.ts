import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { AgentJobRow } from "../../queue.js";
import { runVideoScriptJobWithCompletion } from "./index.js";

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname,
  "../../../../video-render/fixtures/ir/three-scene-v2.json"), "utf8"));
const usage = { inputTokens: 100, outputTokens: 200, costUsd: 0.005 };
const job: AgentJobRow = {
  id: "job-1", agent_key: "video_script", client_id: "client-1",
  input_table: "video_projects", input_id: "project-1",
  params: { source_digest: "a".repeat(64), ir_version: 0 },
  status: "running", attempts: 1, max_attempts: 3,
  lease_owner: "worker-1", lease_until: null,
};

function store(current: boolean[]) {
  const project: Record<string, unknown> = {
    id: "project-1", client_id: "client-1", stage: "queued", job_id: job.id,
    idea: "Explain a reviewed service to prospective buyers.", audience: "AA operators",
    tone: "calm", target_length_sec: 90, aspects: ["16:9", "9:16", "1:1"],
    ir_version: 0, source_digest: "a".repeat(64), ir: null, script: null,
    source_snapshot: [{ id: "source-1", kind: "business", asOf: "2026-11-20",
      text: "The operator reviews the exact version before release." }],
  };
  const costCalls: unknown[] = [];
  const commitCalls: unknown[] = [];
  const queueCalls: unknown[] = [];
  const sb = {
    rpc: vi.fn(async (name: string, args: unknown) => {
      if (name === "video_project_source_current_v1") {
        return { data: current.shift() ?? false, error: null };
      }
      if (name === "record_video_project_cost_v1") {
        costCalls.push(args); return { data: "cost-1", error: null };
      }
      if (name === "commit_video_storyboard_v1") {
        const packet = args as Record<string, unknown>;
        commitCalls.push(packet);
        Object.assign(project, { ir: packet.p_ir, script: packet.p_script,
          ir_version: 1, stage: "needs_human", stage_error: packet.p_stage_error });
        return { data: 1, error: null };
      }
      if (name === "queue_video_audio_v1") {
        queueCalls.push(args);
        Object.assign(project, { stage: "timing", stage_error: null });
        return { data: 3, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    }),
    from: (name: string) => {
      if (name === "agent_job_events") return {
        insert: async () => ({ error: null }),
      };
      if (name !== "video_projects") throw new Error(`Unexpected table ${name}`);
      let patch: Record<string, unknown> | null = null;
      const query = {
        select: () => query,
        update: (next: Record<string, unknown>) => { patch = next; return query; },
        eq: () => query,
        in: async () => {
          if (patch) Object.assign(project, patch);
          return { error: null };
        },
        maybeSingle: async () => {
          if (patch) Object.assign(project, patch);
          return { data: { ...project }, error: null };
        },
      };
      return query;
    },
  };
  return { sb: sb as unknown as SupabaseClient, project, costCalls,
    commitCalls, queueCalls };
}

describe("video script job source and cost gates", () => {
  it("holds stale source before a model call", async () => {
    const { sb, project, costCalls } = store([false]);
    const complete = vi.fn();
    const result = await runVideoScriptJobWithCompletion(sb, job, complete, complete, "Catalogue");
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(complete).not.toHaveBeenCalled();
    expect(project.stage).toBe("needs_human");
    expect(costCalls).toHaveLength(0);
  });
  it("records cost but holds a draft whose source changes during writing", async () => {
    const { sb, project, costCalls } = store([true, false]);
    const complete = vi.fn().mockResolvedValue({ text: JSON.stringify({ ir: fixture,
      sceneSources: fixture.scenes.map((scene: { id: string }) => ({
        sceneId: scene.id, sourceIds: ["source-1"],
      })) }), usage });
    const result = await runVideoScriptJobWithCompletion(sb, job, complete, complete, "Catalogue");
    expect(result).toMatchObject({ ok: false, retryable: false, usage });
    expect(project.stage).toBe("needs_human");
    expect(project.ir).toBeNull();
    expect(costCalls).toHaveLength(1);
  });
  it("stores a valid draft for review once and treats job replay as idempotent", async () => {
    const { sb, project, costCalls, commitCalls, queueCalls } = store([true, true, true]);
    const complete = vi.fn().mockResolvedValue({ text: JSON.stringify({ ir: fixture,
      sceneSources: fixture.scenes.map((scene: { id: string }) => ({
        sceneId: scene.id, sourceIds: ["source-1"],
      })) }), usage });
    const review = vi.fn().mockResolvedValue({
      text: JSON.stringify({ verdict: "pass", reasons: [], edits: [] }), usage,
    });
    expect(await runVideoScriptJobWithCompletion(sb, job, complete, review, "Catalogue"))
      .toMatchObject({ ok: true, usage: { inputTokens: 200, outputTokens: 400,
        costUsd: 0.01 } });
    expect(project.stage).toBe("timing");
    expect(project.stage_error).toBeNull();
    expect(project.script).toMatchObject({ source_digest: "a".repeat(64) });
    expect((project.script as { scene_sources: unknown[] }).scene_sources).toHaveLength(3);
    expect(project.ir_version).toBe(1);
    expect(await runVideoScriptJobWithCompletion(sb, job, complete, review, "Catalogue"))
      .toMatchObject({ ok: true });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledTimes(1);
    expect(costCalls).toHaveLength(2);
    expect(commitCalls).toHaveLength(1);
    expect(queueCalls).toHaveLength(1);
  });
  it("records both model calls and holds an invalid independent review", async () => {
    const { sb, project, costCalls } = store([true, true]);
    const complete = vi.fn().mockResolvedValue({ text: JSON.stringify({ ir: fixture,
      sceneSources: fixture.scenes.map((scene: { id: string }) => ({
        sceneId: scene.id, sourceIds: ["source-1"],
      })) }), usage });
    const review = vi.fn().mockResolvedValue({ text: "not JSON", usage });
    const result = await runVideoScriptJobWithCompletion(sb, job, complete, review, "Catalogue");
    expect(result).toMatchObject({ ok: false, retryable: false,
      usage: { inputTokens: 200, outputTokens: 400, costUsd: 0.01 } });
    expect(project.stage).toBe("needs_human");
    expect(project.ir).toBeNull();
    expect(costCalls).toHaveLength(2);
  });
  it("recovers an accepted storyboard after a crash before audio enqueue", async () => {
    const { sb, project, queueCalls, costCalls } = store([]);
    Object.assign(project, { stage: "needs_human", ir_version: 1,
      ir: fixture, script: { independent_review: { accepted: true } } });
    const complete = vi.fn();
    const result = await runVideoScriptJobWithCompletion(sb, job,
      complete, complete, "Catalogue");
    expect(result).toMatchObject({ ok: true, retryable: false });
    expect(project.stage).toBe("timing");
    expect(queueCalls).toHaveLength(1);
    expect(costCalls).toHaveLength(0);
    expect(complete).not.toHaveBeenCalled();
  });
  it("keeps an explicit independent-review failure out of audio", async () => {
    const { sb, project, queueCalls } = store([true, true, true]);
    const complete = vi.fn().mockResolvedValue({ text: JSON.stringify({ ir: fixture,
      sceneSources: fixture.scenes.map((scene: { id: string }) => ({
        sceneId: scene.id, sourceIds: ["source-1"],
      })) }), usage });
    const review = vi.fn().mockResolvedValue({ text: JSON.stringify({
      verdict: "fail", reasons: ["Unsupported claim"], edits: [],
    }), usage });
    expect(await runVideoScriptJobWithCompletion(sb, job,
      complete, review, "Catalogue")).toMatchObject({ ok: true });
    expect(project.stage).toBe("needs_human");
    expect(queueCalls).toHaveLength(0);
  });
});
