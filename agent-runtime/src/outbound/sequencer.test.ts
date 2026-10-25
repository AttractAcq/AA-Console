import { describe, expect, it, vi } from "vitest";

import { runNurtureSequencerJob } from "./sequencer.js";
import type { RuntimeConfig } from "../config.js";
import type { AgentRow } from "../orchestration/registry.js";
import type { AgentJobRow } from "../queue.js";

/**
 * The sequencer — G11.
 *
 * It holds almost no logic on purpose, so the tests are about the two things
 * a thin worker can still get wrong: running while sending is off, and the
 * order of its two calls.
 */
const agent = {} as AgentRow;
const job = { id: "job-1", params: { limit: 50 } } as unknown as AgentJobRow;

const config = (over: Partial<RuntimeConfig> = {}) =>
  ({ outboundMessagingEnabled: true, ...over }) as RuntimeConfig;

function database(over: Record<string, unknown> = {}) {
  const events: Record<string, unknown>[] = [];
  const order: string[] = [];
  const rpc = vi.fn(async (name: string, _args?: unknown) => {
    order.push(name);
    if (name in over) return over[name] as { data: unknown; error: unknown };
    if (name === "enroll_due_leads_v6") return { data: 2, error: null };
    if (name === "advance_sequences_v6") return { data: 3, error: null };
    return { data: null, error: null };
  });
  const from = vi.fn(() => ({
    insert: vi.fn(async (row: Record<string, unknown>) => {
      events.push(row);
      return { error: null };
    }),
  }));
  return { sb: { rpc, from } as never, rpc, events, order };
}

describe("the sequencer", () => {
  it("enrols nobody and queues nothing while sending is off", async () => {
    const { sb, rpc, events } = database();
    const result = await runNurtureSequencerJob(sb, config({ outboundMessagingEnabled: false }), agent, job);
    expect(result.ok).toBe(true);
    // Enrolling while nothing can send would build a backlog that all leaves
    // at once the day somebody turns sending on.
    expect(rpc).not.toHaveBeenCalled();
    expect(String(events[0]!.description)).toMatch(/No lead was enrolled and no step was queued/);
  });

  it("enrols before advancing, so a zero-hour first step goes this tick", async () => {
    const { sb, order } = database();
    await runNurtureSequencerJob(sb, config(), agent, job);
    expect(order).toEqual(["enroll_due_leads_v6", "advance_sequences_v6"]);
  });

  it("reports both counts and says who actually sends", async () => {
    const { sb, events } = database();
    await runNurtureSequencerJob(sb, config(), agent, job);
    expect(String(events[0]!.description))
      .toBe("2 lead(s) enrolled, 3 step(s) queued. The courier sends them.");
  });

  it("retries a failed enrolment", async () => {
    const { sb } = database({ enroll_due_leads_v6: { data: null, error: { message: "locked" } } });
    const result = await runNurtureSequencerJob(sb, config(), agent, job);
    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  it("keeps the enrolments when advancing fails, and says so", async () => {
    const { sb } = database({ advance_sequences_v6: { data: null, error: { message: "timeout" } } });
    const result = await runNurtureSequencerJob(sb, config(), agent, job);
    // Enrolment is idempotent per lead and sequence, so the retry re-enrols
    // nobody and simply advances what is due.
    expect(result.ok).toBe(false);
    expect(result.failureMessage).toContain("Enrolled 2, but could not advance");
  });
});
