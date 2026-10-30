import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { AgentJobRow } from "../../queue.js";
import { debugToken, runTokenHealthJob } from "./index.js";

const NOW = Date.UTC(2027, 0, 1, 12, 0, 0);
const inDays = (days: number) => Math.floor((NOW + days * 86_400_000) / 1000);
const isoInDays = (days: number) => new Date(NOW + days * 86_400_000).toISOString();
const config = {} as RuntimeConfig;
const agent = { agent_key: "token_health" } as unknown as AgentRow;
const job = { id: "job-1", client_id: null, params: {} } as unknown as AgentJobRow;

type Row = {
  id: string;
  client_id: string;
  provider: string;
  status: string;
  credential_secret_id: string | null;
  token_expires_at: string | null;
};
type Options = {
  secret?: string | null;
  secretError?: boolean;
  allowExpiring?: boolean;
  beforeWrite?: (rows: Row[]) => void;
};

function database(rows: Row[], opts: Options = {}) {
  const stored = rows.map((row) => ({ ...row }));
  const updates: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  let beforeWriteRan = false;
  const rpc = vi.fn(async (_name: string, args: { p_client_id: string; p_provider: string }) => {
    if (opts.secretError) return { data: null, error: { message: "database unavailable" } };
    const matched = stored.find((row) =>
      row.client_id === args.p_client_id && row.provider === args.p_provider &&
      (row.status === "connected" || row.status === "active" ||
        (opts.allowExpiring && row.status === "expiring" &&
          row.token_expires_at !== null && Date.parse(row.token_expires_at) > NOW)));
    return { data: matched ? ("secret" in opts ? opts.secret : "tok") : null, error: null };
  });

  const from = vi.fn((table: string) => {
    if (table === "agent_job_events") {
      return {
        insert: vi.fn(async (event: Record<string, unknown>) => {
          events.push(event);
          return { error: null };
        }),
      };
    }
    const query = {
      select: () => query,
      not: () => query,
      eq: () => query,
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: stored.map((row) => ({ ...row })), error: null }).then(resolve),
      update: (patch: Record<string, unknown>) => {
        const filters: Record<string, unknown> = {};
        const updateQuery = {
          eq: (column: string, value: unknown) => {
            filters[column] = value;
            return updateQuery;
          },
          select: async () => {
            if (!beforeWriteRan) {
              beforeWriteRan = true;
              opts.beforeWrite?.(stored);
            }
            const matched = stored.filter((row) =>
              Object.entries(filters).every(([column, value]) => row[column as keyof Row] === value));
            for (const current of matched) {
              updates.push({ ...patch, id: current.id, filters: { ...filters } });
              Object.assign(current, patch);
            }
            return { data: matched.map(({ id }) => ({ id })), error: null };
          },
        };
        return updateQuery;
      },
    };
    return query;
  });

  return { sb: { from, rpc } as unknown as SupabaseClient, rpc, stored, updates, events };
}

const row = (over: Partial<Row> = {}): Row => ({
  id: "i1",
  client_id: "c1",
  provider: "instagram",
  status: "connected",
  credential_secret_id: "secret-1",
  token_expires_at: null,
  ...over,
});
const healthy = async () => ({ data: { is_valid: true, expires_at: inDays(60) } });
const dead = async () => ({ data: { is_valid: false } });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the daily check", () => {
  it.each(["error", "revoked", "expired"])("never re-probes or reactivates %s", async (status) => {
    const check = vi.fn(healthy);
    const { sb, rpc, updates, events } = database([row({ status })]);
    const result = await runTokenHealthJob(sb, config, agent, job, 0, { check, now: () => NOW });
    expect(result.ok).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect((events[0]!.payload as { trouble: string[] }).trouble[0]).toMatch(/requires a new credential/);
  });

  it("never sends another provider credential to Meta", async () => {
    const check = vi.fn(healthy);
    const { sb, rpc, updates, events } = database([row({ provider: "google_business" })]);
    await runTokenHealthJob(sb, config, agent, job, 0, { check, now: () => NOW });
    expect(rpc).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(events[0]!.description).toMatch(/1 skipped/);
  });

  it("preserves active and records a qualified health detail", async () => {
    const { sb, updates } = database([row({ status: "active" })]);
    await runTokenHealthJob(sb, config, agent, job, 0, { check: healthy, now: () => NOW });
    expect(updates[0]).toMatchObject({ status: "active", token_expires_at: isoInDays(60) });
    expect(String(updates[0]!.health_detail)).toMatch(/permissions are not verified/);
    expect(updates[0]!.filters).toMatchObject({
      id: "i1", client_id: "c1", provider: "instagram", status: "active", credential_secret_id: "secret-1",
    });
  });

  it("demotes a definitively invalid token", async () => {
    const { sb, updates, events } = database([row({ status: "active" })]);
    await runTokenHealthJob(sb, config, agent, job, 0, { check: dead, now: () => NOW });
    expect(updates[0]).toMatchObject({ status: "error" });
    expect((events[0]!.payload as { trouble: string[] }).trouble[0]).toMatch(/no longer valid/);
  });

  it("records near expiry without writing a state that released SQL rejects", async () => {
    const { sb, updates, events } = database([row({ status: "active" })]);
    await runTokenHealthJob(sb, config, agent, job, 0, {
      check: async () => ({ data: { is_valid: true, expires_at: inDays(2) } }),
      now: () => NOW,
    });
    expect(updates[0]).toMatchObject({ status: "active", token_expires_at: isoInDays(2) });
    expect(String(updates[0]!.health_detail)).toMatch(/expires in 2 days/);
    expect(events[0]!.description).toMatch(/1 expiring soon/);
  });

  it("preserves expiring when the guarded RPC refuses it on released SQL", async () => {
    const check = vi.fn(healthy);
    const { sb, updates, events } = database([row({ status: "expiring", token_expires_at: isoInDays(2) })]);
    await runTokenHealthJob(sb, config, agent, job, 0, { check, now: () => NOW });
    expect(check).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(events[0]!.description).toMatch(/1 skipped/);
  });

  it("re-probes a future expiring token under migration 291 without clearing its status", async () => {
    const check = vi.fn(healthy);
    const { sb, rpc, updates } = database(
      [row({ status: "expiring", token_expires_at: isoInDays(2) })], { allowExpiring: true },
    );
    await runTokenHealthJob(sb, config, agent, job, 0, { check, now: () => NOW });
    expect(rpc).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledOnce();
    expect(updates[0]).toMatchObject({ status: "expiring", token_expires_at: isoInDays(60) });
  });

  it("preserves recorded expiry when no credential is readable", async () => {
    const { sb, updates } = database([row({ token_expires_at: isoInDays(4) })], { secret: null });
    await runTokenHealthJob(sb, config, agent, job, 0, { check: healthy, now: () => NOW });
    expect(updates[0]).toMatchObject({ status: "error", token_expires_at: isoInDays(4) });
  });

  it("does not turn a transient credential RPC error into a terminal state", async () => {
    const check = vi.fn(healthy);
    const { sb, updates, events } = database([row({ status: "active" })], { secretError: true });
    await runTokenHealthJob(sb, config, agent, job, 0, { check, now: () => NOW });
    expect(check).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(events[0]!.description).toMatch(/1 skipped/);
  });

  it("preserves status when Meta returns HTTP 200 with a non-JSON body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => { throw new SyntaxError("not JSON"); },
    }));
    const { sb, updates, events } = database([row({ status: "active" })]);
    await runTokenHealthJob(sb, config, agent, job, 0, { check: debugToken, now: () => NOW });
    expect(updates).toEqual([]);
    expect(events[0]!.description).toMatch(/1 skipped/);
    expect((events[0]!.payload as { trouble: string[] }).trouble[0]).toMatch(/did not establish token validity/);
  });

  it.each(["status", "credential_secret_id"])("discards a stale verdict after concurrent %s change", async (field) => {
    const { sb, updates, stored, events } = database([row()], {
      beforeWrite: (rows) => { rows[0]![field as "status" | "credential_secret_id"] = field === "status" ? "revoked" : "secret-2"; },
    });
    await runTokenHealthJob(sb, config, agent, job, 0, { check: healthy, now: () => NOW });
    expect(updates).toEqual([]);
    expect(stored[0]![field as keyof Row]).toBe(field === "status" ? "revoked" : "secret-2");
    expect((events[0]!.payload as { trouble: string[] }).trouble[0]).toMatch(/stale verdict discarded/);
  });

  it("skips duplicate client/provider rows because the RPC cannot identify the row", async () => {
    const check = vi.fn(healthy);
    const { sb, rpc, updates, events } = database([
      row(), row({ id: "i2", credential_secret_id: "secret-2" }),
    ]);
    await runTokenHealthJob(sb, config, agent, job, 0, { check, now: () => NOW });
    expect(rpc).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(events[0]!.description).toMatch(/2 skipped/);
  });

  it("counts a credentialless duplicate as ambiguous too", async () => {
    const check = vi.fn(healthy);
    const { sb, rpc, updates } = database([
      row(), row({ id: "i2", credential_secret_id: null }),
    ]);
    await runTokenHealthJob(sb, config, agent, job, 0, { check, now: () => NOW });
    expect(rpc).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });
});

describe("one client's trouble", () => {
  it("does not stop another integration being checked", async () => {
    const check = vi.fn().mockRejectedValueOnce(new Error("socket hang up")).mockImplementation(healthy);
    const { sb, updates, events } = database([
      row({ id: "i1", provider: "instagram" }),
      row({ id: "i2", provider: "meta" }),
    ]);
    const result = await runTokenHealthJob(sb, config, agent, job, 0, { check, now: () => NOW });
    expect(result.ok).toBe(true);
    expect(updates.map((update) => update.id)).toEqual(["i2"]);
    expect((events[0]!.payload as { trouble: string[] }).trouble[0]).toMatch(/socket hang up/);
  });
});

describe("Meta HTTP errors", () => {
  it("treats an explicit OAuth error as invalid", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 400, json: async () => ({ error: { code: 190, message: "Invalid OAuth token" } }),
    }));
    expect(await debugToken("tok")).toMatchObject({ data: { is_valid: false } });
  });

  it("raises a Meta outage rather than declaring a good credential invalid", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 503, json: async () => ({ error: { message: "Unavailable" } }),
    }));
    await expect(debugToken("tok")).rejects.toThrow("HTTP 503");
  });

  it("raises a rate-limit error rather than treating every HTTP 400 as revocation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 400, json: async () => ({ error: { code: 17, message: "Rate limited" } }),
    }));
    await expect(debugToken("tok")).rejects.toThrow("HTTP 400");
  });
});

describe("nothing to do", () => {
  it("says so when no integration has a credential", async () => {
    const { sb, events } = database([]);
    const result = await runTokenHealthJob(sb, config, agent, job, 0, { check: healthy, now: () => NOW });
    expect(result.ok).toBe(true);
    expect(events[0]!.description).toMatch(/No integrations/);
  });
});
