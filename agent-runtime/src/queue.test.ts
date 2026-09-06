import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  claimNextJob,
  markJobCompleted,
  markJobFailed,
  markJobRunning,
} from "./queue.js";

/**
 * supabase-js's query builder is chainable (`.eq().eq()`) and thenable
 * (`await`-able without a terminal `.then()` call in the caller). This
 * fake reproduces just enough of that shape to drive queue.ts without a
 * live database, and records every `.update()` patch so tests can assert
 * on what would have been written.
 */
function fakeUpdateClient(result: { error: { message: string } | null; count: number | null }) {
  const capture: { table?: string; patch?: Record<string, unknown> } = {};
  const chain = {
    eq() {
      return chain;
    },
    then(resolve: (value: typeof result) => void) {
      resolve(result);
    },
  };
  const sb = {
    from(table: string) {
      capture.table = table;
      return {
        update(patch: Record<string, unknown>) {
          capture.patch = patch;
          return chain;
        },
      };
    },
  } as unknown as SupabaseClient;
  return { sb, capture };
}

function fakeRpcClient(result: { data: unknown; error: { message: string } | null }) {
  return {
    rpc: vi.fn().mockResolvedValue(result),
  } as unknown as SupabaseClient;
}

describe("claimNextJob", () => {
  it("returns null for the SQL NULL-as-all-null-fields row, not just for null", async () => {
    // The exact shape claim_agent_job returns when the queue is empty:
    // a composite row of all-null fields, not a bare null.
    const sb = fakeRpcClient({
      data: { id: null, agent_key: null, client_id: null, status: null },
      error: null,
    });
    expect(await claimNextJob(sb, "owner-1", 900)).toBeNull();
  });

  it("returns the row when a real job is claimed", async () => {
    const row = { id: "job-1", agent_key: "icp", client_id: "client-1", status: "claimed" };
    const sb = fakeRpcClient({ data: row, error: null });
    expect(await claimNextJob(sb, "owner-1", 900)).toEqual(row);
  });

  it("throws when the RPC itself errors", async () => {
    const sb = fakeRpcClient({ data: null, error: { message: "boom" } });
    await expect(claimNextJob(sb, "owner-1", 900)).rejects.toThrow(/boom/);
  });
});

describe("lease-scoped state transitions", () => {
  it("markJobRunning succeeds when exactly one row matched", async () => {
    const { sb } = fakeUpdateClient({ error: null, count: 1 });
    await expect(markJobRunning(sb, "job-1", "owner-1")).resolves.toBeUndefined();
  });

  it("markJobRunning throws when the lease was stolen (count !== 1)", async () => {
    const { sb } = fakeUpdateClient({ error: null, count: 0 });
    await expect(markJobRunning(sb, "job-1", "owner-1")).rejects.toThrow(/lease ownership lost/);
  });

  it("markJobCompleted throws on a database error even if a row was matched", async () => {
    const { sb } = fakeUpdateClient({ error: { message: "connection reset" }, count: 1 });
    await expect(markJobCompleted(sb, "job-1", "owner-1")).rejects.toThrow(/connection reset/);
  });
});

describe("markJobFailed", () => {
  it("keeps a retryable failure under the attempt cap alive: no completed_at, not terminal", async () => {
    const { sb, capture } = fakeUpdateClient({ error: null, count: 1 });
    await markJobFailed(sb, "job-1", "owner-1", 1, 3, true, "transient error");
    expect(capture.patch?.completed_at).toBeNull();
    expect(capture.patch?.terminal).toBe(false);
    expect(capture.patch?.attempts).toBe(1);
  });

  it("makes a non-retryable failure terminal without inflating the attempt count", async () => {
    const { sb, capture } = fakeUpdateClient({ error: null, count: 1 });
    await markJobFailed(sb, "job-1", "owner-1", 1, 3, false, "fatal error");
    expect(capture.patch?.terminal).toBe(true);
    expect(capture.patch?.completed_at).not.toBeNull();
    // The job tried once and gave up on purpose. Reporting 3 here is what
    // made a missing API key read as a flaky, thrice-retried fault.
    expect(capture.patch?.attempts).toBe(1);
  });

  it("makes a retryable failure terminal once the attempt cap is reached", async () => {
    const { sb, capture } = fakeUpdateClient({ error: null, count: 1 });
    await markJobFailed(sb, "job-1", "owner-1", 3, 3, true, "still failing");
    expect(capture.patch?.terminal).toBe(true);
    expect(capture.patch?.attempts).toBe(3);
    expect(capture.patch?.completed_at).not.toBeNull();
  });

  it("truncates the failure message to 2000 chars", async () => {
    const { sb, capture } = fakeUpdateClient({ error: null, count: 1 });
    await markJobFailed(sb, "job-1", "owner-1", 1, 3, true, "x".repeat(3000));
    expect(capture.patch?.error).toHaveLength(2000);
  });
});
