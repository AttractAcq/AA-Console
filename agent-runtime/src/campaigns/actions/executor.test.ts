import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { AgentJobRow } from "../../queue.js";
import { runCampaignActionJob, HANDLERS, type ClaimedAction } from "./executor.js";

/**
 * The executor's own behaviour, with the database faked.
 *
 * What is worth asserting here is everything that decides whether an
 * external act happens and whether the record of it is true: the runtime
 * switch, an action with no handler, a failure's retryability, and the case
 * where the act succeeded but recording it did not. The SQL guarantees --
 * stale packages, switches, hashes -- are asserted against a real Postgres
 * in campaign-action-executor.pg.test.ts, because that is where they live.
 */

const agent = { agent_key: "campaign_action_executor" } as unknown as AgentRow;
const job = { id: "job-1", params: { limit: 3 } } as unknown as AgentJobRow;
const on = { campaignActionsEnabled: true } as RuntimeConfig;
const off = { campaignActionsEnabled: false } as RuntimeConfig;

const ACTION: ClaimedAction = {
  execution_id: "exec-1",
  approval_id: "appr-1",
  client_id: "client-1",
  campaign_id: "camp-1",
  manifest_id: "man-1",
  action_key: "proof_publish",
  destination: "Third Party Directories",
  artifact_version_hash: "a".repeat(64),
  scope: { placements: [{ placement_id: "pl-1", payload_hash: "b".repeat(64) }] },
  attempt: 1,
};

function database(
  options: {
    claimed?: ClaimedAction[];
    release?: { released?: number; skipped?: unknown[] };
    releaseError?: string;
    recordError?: string;
    enrol?: { enrolled?: number; skipped?: unknown[]; sequence_name?: string };
    enrolError?: string;
  } = {},
) {
  const events: Record<string, unknown>[] = [];
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "claim_campaign_actions") {
      return { data: options.claimed ?? [ACTION], error: null };
    }
    if (name === "release_campaign_proof_placements") {
      if (options.releaseError) return { data: null, error: { message: options.releaseError } };
      return { data: options.release ?? { released: 1, skipped: [] }, error: null };
    }
    if (name === "enrol_campaign_leads_in_sequence_v6") {
      if (options.enrolError) return { data: null, error: { message: options.enrolError } };
      return { data: options.enrol ?? { enrolled: 1, skipped: [] }, error: null };
    }
    if (name === "record_campaign_action_executed" && options.recordError) {
      return { data: null, error: { message: options.recordError } };
    }
    return { data: null, error: null };
  });
  const from = vi.fn((table: string) => {
    if (table === "agent_job_events") {
      return {
        insert: vi.fn(async (row: Record<string, unknown>) => {
          events.push(row);
          return { error: null };
        }),
      };
    }
    throw new Error(`The executor should not be reading ${table}.`);
  });
  return { sb: { rpc, from } as unknown as SupabaseClient, events, calls, rpc };
}

/** Every rpc call of one name, in order. */
const callsTo = (calls: Array<{ name: string; args: Record<string, unknown> }>, name: string) =>
  calls.filter((call) => call.name === name).map((call) => call.args);

describe("the runtime switch", () => {
  it("claims nothing at all when campaign actions are off", async () => {
    const { sb, calls, events } = database();
    const result = await runCampaignActionJob(sb, off, agent, job);

    expect(result).toEqual({ ok: true, retryable: false });
    // Not a dry run: nothing is claimed, so nothing can be recorded as done.
    expect(callsTo(calls, "claim_campaign_actions")).toHaveLength(0);
    expect(String(events[0]?.description)).toContain("CAMPAIGN_ACTIONS_ENABLED");
  });

  it("says so plainly when nothing is approved and waiting", async () => {
    const { sb, events } = database({ claimed: [] });
    await runCampaignActionJob(sb, on, agent, job);
    expect(String(events[0]?.description)).toContain("No approved action is waiting");
  });
});

describe("performing an approved action", () => {
  it("releases the placements and records the result against the execution", async () => {
    const { sb, calls } = database({ release: { released: 2, skipped: [] } });
    await runCampaignActionJob(sb, on, agent, job);

    expect(callsTo(calls, "release_campaign_proof_placements")).toEqual([
      { p_execution_id: "exec-1" },
    ]);
    expect(callsTo(calls, "record_campaign_action_executed")).toEqual([
      {
        p_execution_id: "exec-1",
        p_external_id: null,
        p_external_url: null,
        p_result: { released: 2, skipped: [] },
      },
    ]);
    expect(callsTo(calls, "record_campaign_action_failure")).toHaveLength(0);
  });

  it("keeps the skipped placements on the record rather than only the count", async () => {
    const skipped = [{ placement_id: "pl-9", reason: "The payload changed after approval." }];
    const { sb, calls } = database({ release: { released: 1, skipped } });
    await runCampaignActionJob(sb, on, agent, job);

    expect(callsTo(calls, "record_campaign_action_executed")[0]).toMatchObject({
      p_result: { released: 1, skipped },
    });
  });

  it("fails, non-retryably, when the decision released nothing", async () => {
    // Everything named in the approval has moved on. Trying again would ask
    // the same question of the same unchanged rows.
    const { sb, calls } = database({
      release: { released: 0, skipped: [{ reason: "The placement is retracted." }] },
    });
    await runCampaignActionJob(sb, on, agent, job);

    const failure = callsTo(calls, "record_campaign_action_failure")[0]!;
    expect(failure.p_retryable).toBe(false);
    expect(String(failure.p_reason)).toContain("retracted");
    expect(callsTo(calls, "record_campaign_action_executed")).toHaveLength(0);
  });

  it("treats a database error on release as retryable", async () => {
    const { sb, calls } = database({ releaseError: "could not serialize access" });
    await runCampaignActionJob(sb, on, agent, job);

    expect(callsTo(calls, "record_campaign_action_failure")[0]).toMatchObject({
      p_retryable: true,
    });
  });
});

describe("an action with nothing to perform it", () => {
  it("fails loudly rather than leaving it claimed", async () => {
    // Only reachable by marking an action supported without writing its
    // executor, which is exactly the mistake worth a loud failure.
    const { sb, calls } = database({
      claimed: [{ ...ACTION, action_key: "google_ad_build" }],
    });
    await runCampaignActionJob(sb, on, agent, job);

    const failure = callsTo(calls, "record_campaign_action_failure")[0]!;
    expect(String(failure.p_reason)).toContain("no executor for google ad build");
    expect(failure.p_retryable).toBe(false);
  });

  it("registers an executor only for the actions that have one", () => {
    // The guard on the other direction: this list and
    // campaign_action_executors.supported have to agree, and the failure
    // mode of them disagreeing is an action claimed and then failed.
    expect(Object.keys(HANDLERS)).toEqual(["proof_publish", "page_deploy", "lead_message"]);
  });
});

describe("done but not recorded", () => {
  it("records a failure that says the act happened", async () => {
    const { sb, calls } = database({ recordError: "deadlock detected" });
    await runCampaignActionJob(sb, on, agent, job);

    const failure = callsTo(calls, "record_campaign_action_failure")[0]!;
    // The wording matters: whoever reads this has to know the external side
    // may already have changed, so a retry is not obviously safe.
    expect(String(failure.p_reason)).toContain("Done, but could not be recorded");
    expect(failure.p_retryable).toBe(false);
  });
});

describe("one action's failure is its own", () => {
  it("carries on to the next action and reports both", async () => {
    const { sb, calls, events } = database({
      claimed: [
        // Still without an executor, so it is the one that fails loudly.
        { ...ACTION, action_key: "google_ad_build", execution_id: "exec-bad" },
        { ...ACTION, execution_id: "exec-good" },
      ],
    });
    await runCampaignActionJob(sb, on, agent, job);

    expect(callsTo(calls, "record_campaign_action_failure")[0]).toMatchObject({
      p_execution_id: "exec-bad",
    });
    expect(callsTo(calls, "record_campaign_action_executed")[0]).toMatchObject({
      p_execution_id: "exec-good",
    });
    expect(events.map((event) => String(event.description))).toContain("1 done, 1 not.");
  });
});

/**
 * G11's handler: enrolling a campaign's leads.
 *
 * The thing worth pinning is the blast radius. Enrolling is not sending, so
 * a hundred enrolments is not a hundred emails — but enrolling nobody when
 * the approval said somebody was eligible means something changed, and that
 * should reach a person rather than be recorded as a success.
 */
describe("enrolling a campaign's leads", () => {
  const leadMessage: ClaimedAction = {
    ...ACTION,
    action_key: "lead_message",
    destination: "nurture sequence: Objections",
    scope: { sequence_id: "seq-1", steps: 3 },
  };

  it("records what it enrolled and names the sequence", async () => {
    const { sb, calls, events } = database({
      claimed: [leadMessage],
      enrol: { enrolled: 4, skipped: [], sequence_name: "Objections" },
    });
    await runCampaignActionJob(sb, on, agent, job);

    const executed = calls.find((c) => c.name === "record_campaign_action_executed");
    expect(executed).toBeDefined();
    // The count goes on the row; the sentence goes on the job's events, which
    // is where a person reads it.
    expect((executed!.args as { p_result?: { enrolled?: number } }).p_result)
      .toMatchObject({ enrolled: 4 });
    expect(events.some((e) => String(e.description).includes("Enrolled 4 leads into Objections.")))
      .toBe(true);
  });

  it("fails without retrying when nobody turns out to be eligible", async () => {
    const { sb, calls } = database({
      claimed: [leadMessage],
      enrol: {
        enrolled: 0,
        skipped: [{ lead_id: "l-1", reason: "They unsubscribed or complained." }],
      },
    });
    await runCampaignActionJob(sb, on, agent, job);
    const failed = calls.find((c) => c.name === "record_campaign_action_failure");
    expect(failed).toBeDefined();
    const args = failed!.args as { p_retryable?: boolean; p_reason?: string };
    expect(args.p_retryable).toBe(false);
    expect(String(args.p_reason)).toContain("unsubscribed");
  });

  it("retries when the enrolment call itself fails", async () => {
    const { sb, calls } = database({ claimed: [leadMessage], enrolError: "deadlock detected" });
    await runCampaignActionJob(sb, on, agent, job);
    const failed = calls.find((c) => c.name === "record_campaign_action_failure");
    expect((failed!.args as { p_retryable?: boolean }).p_retryable).toBe(true);
  });
});
