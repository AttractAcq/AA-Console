import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "./config.js";
import type { AgentJobRow } from "./queue.js";

const { dispatchJob, hasRunner, getAgent, failSlot } = vi.hoisted(() => ({
  dispatchJob: vi.fn(),
  hasRunner: vi.fn(() => true),
  getAgent: vi.fn(async () => ({ agent_key: "ideation", name: "Ideation" })),
  failSlot: vi.fn(async () => undefined),
}));

vi.mock("./orchestration/dispatch.js", () => ({
  dispatchJob,
  hasRunner,
  registeredAgentKeys: () => ["ideation"],
}));
vi.mock("./orchestration/registry.js", () => ({ getAgent }));
vi.mock("./engine/slot.js", () => ({
  failSlot,
  slotIdOf: (job: AgentJobRow) => (job.params as { slot_id?: string } | null)?.slot_id ?? null,
}));

import { runOneJob } from "./worker.js";

const config = { leaseSeconds: 900, maxJobSeconds: 1800 } as RuntimeConfig;

const JOB = {
  id: "job-1",
  agent_key: "ideation",
  client_id: "client-1",
  attempts: 0,
  max_attempts: 3,
  params: { slot_id: "slot-1" },
} as unknown as AgentJobRow;

function database() {
  const updates: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const rpc = vi.fn(async (_name: string, _args: unknown) => ({ data: null as string | null, error: null as { message: string } | null }));
  const from = vi.fn((table: string) => {
    if (table === "agent_job_events") {
      return {
        insert: vi.fn(async (row: Record<string, unknown>) => {
          events.push(row);
          return { error: null };
        }),
      };
    }
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      update: (patch: Record<string, unknown>) => {
        updates.push(patch);
        return chain;
      },
      eq: () => chain,
      in: () => chain,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ error: null, count: 1 }).then(resolve),
    });
    return chain;
  });
  return { sb: { from, rpc } as unknown as SupabaseClient, updates, events, rpc };
}

beforeEach(() => {
  vi.clearAllMocks();
  hasRunner.mockReturnValue(true);
  getAgent.mockResolvedValue({ agent_key: "ideation", name: "Ideation" } as never);
});

describe("a job that was held", () => {
  it("is paused rather than failed", async () => {
    // `failed` means something broke and a person should look. A monthly cap
    // is not that.
    dispatchJob.mockResolvedValue({
      ok: false,
      retryable: false,
      hold: true,
      failureMessage: "This client has spent $500.00 of its $500.00 cap for the month.",
    });
    const { sb, rpc, updates } = database();
    await runOneJob(sb, config, JOB, "owner-1");

    expect(rpc).toHaveBeenCalledWith(
      "pause_agent_job",
      expect.objectContaining({ p_job_id: "job-1", p_reason: expect.stringContaining("$500.00 cap") }),
    );
    // And nothing wrote status: failed.
    expect(updates.some((u) => u.status === "failed")).toBe(false);
  });

  it("leaves the slot exactly where it is", async () => {
    // The work is still there and will resume. Failing the slot would mean
    // the only way back is failed → planned, which pays for the ideation,
    // the brief and the build a second time.
    dispatchJob.mockResolvedValue({ ok: false, retryable: false, hold: true, failureMessage: "Over cap." });
    const { sb } = database();
    await runOneJob(sb, config, JOB, "owner-1");
    expect(failSlot).not.toHaveBeenCalled();
  });

  it("says so in the job's own log, as a warning rather than an error", async () => {
    dispatchJob.mockResolvedValue({ ok: false, retryable: false, hold: true, failureMessage: "Over cap." });
    const { sb, events } = database();
    await runOneJob(sb, config, JOB, "owner-1");
    const held = events.find((e) => (e.payload as { held?: boolean } | undefined)?.held);
    expect(held).toBeDefined();
    expect(held!.level).toBe("warn");
    expect(held!.description).toBe("Over cap.");
  });
});

describe("a job that genuinely failed", () => {
  it("still fails, and still fails its slot", async () => {
    dispatchJob.mockResolvedValue({ ok: false, retryable: false, failureMessage: "The brief has no hook." });
    const { sb, rpc, updates } = database();
    await runOneJob(sb, config, JOB, "owner-1");

    expect(updates.some((u) => u.status === "failed")).toBe(true);
    expect(failSlot).toHaveBeenCalledWith(
      sb,
      "slot-1",
      "The brief has no hook.",
      expect.objectContaining({ jobId: "job-1" }),
    );
    expect(rpc).not.toHaveBeenCalledWith("pause_agent_job", expect.anything());
  });

  it("does not fail the slot while a retry is still coming", async () => {
    dispatchJob.mockResolvedValue({ ok: false, retryable: true, failureMessage: "Rate limited." });
    const { sb } = database();
    await runOneJob(sb, config, JOB, "owner-1");
    expect(failSlot).not.toHaveBeenCalled();
  });
});

describe("a job that worked", () => {
  it("is completed and holds nothing", async () => {
    dispatchJob.mockResolvedValue({ ok: true, retryable: false });
    const { sb, rpc, updates } = database();
    await runOneJob(sb, config, JOB, "owner-1");
    expect(updates.some((u) => u.status === "completed")).toBe(true);
    expect(rpc).not.toHaveBeenCalledWith("pause_agent_job", expect.anything());
    expect(failSlot).not.toHaveBeenCalled();
  });
});

it("holds hard-budget work before dispatch when the reservation cannot be read", async () => {
  const { sb, rpc, updates } = database();
  rpc.mockRejectedValueOnce(new Error("fixture transport failure"));
  await runOneJob(sb, { ...config, model: "claude-opus-5" }, { ...JOB, agent_key: "icp", hard_budget_required: true }, "owner");
  expect(dispatchJob).not.toHaveBeenCalled();
  expect(updates).toEqual([expect.objectContaining({ status: "paused", lease_owner: null })]);
});

it("holds an unpriced agent before it can reach any provider", async () => {
  const { sb, rpc, updates } = database();
  await runOneJob(sb, config, { ...JOB, hard_budget_required: true }, "owner");
  expect(dispatchJob).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();
  expect(updates[0]?.status).toBe("paused");
});

it("dispatches Market with its reserved tenant model without changing the shared worker config", async () => {
  const { sb, rpc } = database();
  const settings = { ...config, model: "claude-opus-5" };
  rpc.mockResolvedValueOnce({ data: "claude-sonnet-4-6", error: null });
  dispatchJob.mockResolvedValue({ ok: true, retryable: false });
  const job = { ...JOB, agent_key: "market", hard_budget_required: true };
  await runOneJob(sb, settings, job, "owner");
  expect(rpc).toHaveBeenCalledWith("client_model_budget_policy", { p_client_id: job.client_id });
  expect(rpc).toHaveBeenCalledWith("reserve_agent_budget_turn", expect.objectContaining({ p_usd: 67.86456 }));
  expect(dispatchJob).toHaveBeenCalledWith(sb, expect.objectContaining({ model: "claude-sonnet-4-6" }), expect.anything(), job);
  expect(settings.model).toBe("claude-opus-5");
});

it("holds Market before dispatch if the approved model reservation does not fit", async () => {
  const { sb, rpc, updates } = database();
  rpc.mockResolvedValueOnce({ data: "claude-sonnet-4-6", error: null })
    .mockResolvedValueOnce({ data: null, error: { message: "Hard cap: call requires USD 67.86456, available USD 50" } });
  await runOneJob(sb, { ...config, model: "claude-opus-5" }, { ...JOB, agent_key: "market", hard_budget_required: true }, "owner");
  expect(dispatchJob).not.toHaveBeenCalled();
  expect(updates[0]).toMatchObject({ status: "paused", hard_budget_retry_usd: 67.86456 });
});
