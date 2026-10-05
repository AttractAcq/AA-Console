import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { AgentJobRow } from "../../queue.js";
import { runIdeaSelectJob } from "./index.js";

const SLOT = {
  id: "slot-1",
  client_id: "client-1",
  stage: "ideating",
  format: "single",
  platform: "instagram",
  scheduled_at: "2026-11-02T09:00:00Z",
  pillar_id: "pillar-1",
  idea_id: null,
  brief_id: null,
  asset_id: null,
  attempts: 0,
};

const config = {} as RuntimeConfig;
const agent = { agent_key: "idea_select" } as unknown as AgentRow;
const job = {
  id: "job-1",
  client_id: "client-1",
  input_table: "content_slots",
  input_id: "slot-1",
  params: { slot_id: "slot-1", source: "engine" },
} as unknown as AgentJobRow;

function database(options: { slot?: unknown; rpc?: { data?: unknown; error?: { message: string } } } = {}) {
  const events: Record<string, unknown>[] = [];
  const rpc = vi.fn().mockResolvedValue(options.rpc ?? { data: DECISION, error: null });
  const from = vi.fn((table: string) => {
    if (table === "agent_job_events") {
      return {
        insert: vi.fn(async (row: Record<string, unknown>) => {
          events.push(row);
          return { error: null };
        }),
      };
    }
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: "slot" in options ? options.slot : SLOT, error: null }),
        }),
      }),
    };
  });
  return { sb: { from, rpc } as unknown as SupabaseClient, rpc, events };
}

const DECISION = [
  {
    idea_id: "idea-1",
    score: "88.00",
    reasons: ["Nothing like it in this client's archive."],
    considered: [{ idea_id: "idea-2", title: "Runner up", score: 60 }],
  },
];

describe("the idea selector", () => {
  it("asks the database to choose, and spends no tokens doing it", async () => {
    const { sb, rpc } = database();
    const result = await runIdeaSelectJob(sb, config, agent, job);
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith("select_idea_for_slot", { p_slot_id: "slot-1" });
    // No usage reported, because nothing was charged for.
    expect(result.usage).toBeUndefined();
  });

  it("says how many it chose between, and why", async () => {
    const { sb, events } = database();
    await runIdeaSelectJob(sb, config, agent, job);
    const [event] = events;
    expect(event!.description).toMatch(/Chose 1 of 2 candidates, scoring 88.00\/100/);
    expect((event!.payload as { reasons: string[] }).reasons[0]).toMatch(/archive/);
  });

  it("does not move the slot itself", async () => {
    // select_idea_for_slot moved it as part of approving the idea. A second
    // move would be a second answer to a question already settled, and
    // advance_slot would refuse it.
    const { sb, rpc } = database();
    await runIdeaSelectJob(sb, config, agent, job);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).not.toHaveBeenCalledWith("advance_slot", expect.anything());
  });

  it("treats nothing to choose between as final, not as something to retry", async () => {
    // Ideation may have produced nothing usable. Retrying would re-run the
    // same selection over the same empty set.
    const { sb } = database({
      rpc: { error: { message: "There are no undecided ideas for this slot to choose between." } },
    });
    const result = await runIdeaSelectJob(sb, config, agent, job);
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
  });

  it("treats a database fault as worth retrying", async () => {
    const { sb } = database({ rpc: { error: { message: "could not serialize access" } } });
    const result = await runIdeaSelectJob(sb, config, agent, job);
    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  it("refuses a job with no slot rather than inventing one", async () => {
    const { sb, rpc } = database();
    const result = await runIdeaSelectJob(sb, config, agent, {
      ...job,
      params: {},
    } as unknown as AgentJobRow);
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(result.failureMessage).toMatch(/only runs for a slot/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a job naming a slot that is gone", async () => {
    const { sb, rpc } = database({ slot: null });
    const result = await runIdeaSelectJob(sb, config, agent, job);
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(rpc).not.toHaveBeenCalled();
  });
});
