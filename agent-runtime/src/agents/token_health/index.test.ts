import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { AgentJobRow } from "../../queue.js";
import { runTokenHealthJob } from "./index.js";

const NOW = Date.UTC(2027, 0, 1, 12, 0, 0);
const inDays = (days: number) => Math.floor((NOW + days * 86_400_000) / 1000);

const config = {} as RuntimeConfig;
const agent = { agent_key: "token_health" } as unknown as AgentRow;
const job = { id: "job-1", client_id: null, params: {} } as unknown as AgentJobRow;

type Row = { id: string; client_id: string; provider: string; status: string };

function database(rows: Row[], opts: { secret?: string | null } = {}) {
  const updates: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const rpc = vi.fn().mockResolvedValue({ data: "secret" in opts ? opts.secret : "tok", error: null });

  const from = vi.fn((table: string) => {
    if (table === "agent_job_events") {
      return {
        insert: vi.fn(async (row: Record<string, unknown>) => {
          events.push(row);
          return { error: null };
        }),
      };
    }
    const chain = {
      select: () => chain,
      not: () => chain,
      eq: vi.fn(async (_col: string, _val: unknown) => ({ error: null })),
      update: (patch: Record<string, unknown>) => ({
        eq: vi.fn(async (_col: string, id: string) => {
          updates.push({ id, ...patch });
          return { error: null };
        }),
      }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
    };
    return chain;
  });

  return { sb: { from, rpc } as unknown as SupabaseClient, updates, events };
}

const row = (over: Partial<Row> = {}): Row => ({
  id: "i1",
  client_id: "c1",
  provider: "instagram",
  status: "connected",
  ...over,
});

const healthy = async () => ({ data: { is_valid: true, expires_at: inDays(60) } });
const dead = async () => ({ data: { is_valid: false } });

beforeEach(() => vi.clearAllMocks());

describe("the daily check", () => {
  it("rescues an integration stuck in error when the token is fine", async () => {
    // The case this agent was written for: a fault that was not the token's
    // left the integration excluded from the scheduler after the fault was
    // fixed.
    const { sb, updates, events } = database([row({ status: "error" })]);
    const result = await runTokenHealthJob(sb, config, agent, job, 0, { check: healthy, now: () => NOW });

    expect(result.ok).toBe(true);
    expect(updates[0]).toMatchObject({ id: "i1", status: "connected" });
    expect(events[0]!.description).toMatch(/1 recovered/);
  });

  it("does not promote a rescued integration to active", async () => {
    // active means an ingest has succeeded. This has not ingested anything.
    const { sb, updates } = database([row({ status: "error" })]);
    await runTokenHealthJob(sb, config, agent, job, 0, { check: healthy, now: () => NOW });
    expect(updates[0]!.status).not.toBe("active");
  });

  it("leaves a working integration working", async () => {
    const { sb, updates } = database([row({ status: "active" })]);
    await runTokenHealthJob(sb, config, agent, job, 0, { check: healthy, now: () => NOW });
    expect(updates[0]).toMatchObject({ status: "active" });
  });

  it("marks a dead token as an error and says so", async () => {
    const { sb, updates, events } = database([row({ status: "active" })]);
    await runTokenHealthJob(sb, config, agent, job, 0, { check: dead, now: () => NOW });
    expect(updates[0]).toMatchObject({ status: "error" });
    expect((events[0]!.payload as { trouble: string[] }).trouble[0]).toMatch(/no longer valid/);
  });

  it("warns about one running out without switching it off", async () => {
    const { sb, updates } = database([row({ status: "active" })]);
    await runTokenHealthJob(sb, config, agent, job, 0, {
      check: async () => ({ data: { is_valid: true, expires_at: inDays(2) } }),
      now: () => NOW,
    });
    expect(updates[0]).toMatchObject({ status: "expiring" });
    expect(String(updates[0]!.health_detail)).toMatch(/expires in 2 days/);
  });

  it("records when the token expires, for the panel", async () => {
    const { sb, updates } = database([row()]);
    await runTokenHealthJob(sb, config, agent, job, 0, { check: healthy, now: () => NOW });
    expect(updates[0]!.token_expires_at).toBe(new Date(NOW + 60 * 86_400_000).toISOString());
  });

  it("treats an unreadable credential as an error rather than skipping it", async () => {
    const { sb, updates } = database([row()], { secret: null });
    await runTokenHealthJob(sb, config, agent, job, 0, { check: healthy, now: () => NOW });
    expect(updates[0]).toMatchObject({ status: "error" });
    expect(String(updates[0]!.health_detail)).toMatch(/No usable credential/);
  });
});

describe("one client's trouble", () => {
  it("does not stop the others being checked", async () => {
    const check = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockImplementation(healthy);
    const { sb, updates, events } = database([
      row({ id: "i1", provider: "instagram" }),
      row({ id: "i2", provider: "meta" }),
    ]);

    const result = await runTokenHealthJob(sb, config, agent, job, 0, { check, now: () => NOW });

    expect(result.ok).toBe(true);
    // The second was still checked and written.
    expect(updates.map((u) => u.id)).toEqual(["i2"]);
    expect((events[0]!.payload as { trouble: string[] }).trouble[0]).toMatch(/socket hang up/);
  });
});

describe("nothing to do", () => {
  it("says so rather than failing when no integration has a credential", async () => {
    const { sb, events } = database([]);
    const result = await runTokenHealthJob(sb, config, agent, job, 0, { check: healthy, now: () => NOW });
    expect(result.ok).toBe(true);
    expect(events[0]!.description).toMatch(/No integrations/);
  });
});
