import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { AgentJobRow } from "../../queue.js";
import {
  ActionError, HANDLERS, enrolCampaignLeads, releaseProofPlacements,
  runCampaignActionJob, type ClaimedAction,
} from "./executor.js";
import { GENERIC_CAMPAIGN_ACTION_CLAIM_HOLD } from "./preclaim-hold.js";

const agent = { agent_key: "campaign_action_executor" } as AgentRow;
const on = { campaignActionsEnabled: true } as RuntimeConfig;
const off = { campaignActionsEnabled: false } as RuntimeConfig;
const job = (params: Record<string, unknown> = { limit: 3 }) =>
  ({ id: "job-1", params }) as AgentJobRow;

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

function database(options: {
  registry?: { metaAdBuildSupported: boolean };
  onInsert?: () => Promise<void>;
} = {}) {
  const events: Record<string, unknown>[] = [];
  const rpc = vi.fn(async (name: string, _args?: unknown) => {
    if (name === "claim_campaign_actions" && options.registry?.metaAdBuildSupported) {
      return { data: [{ ...ACTION, action_key: "meta_ad_build" }], error: null };
    }
    return { data: null, error: null };
  });
  const from = vi.fn((table: string) => {
    if (table !== "agent_job_events") {
      throw new Error("The held sweep must not read " + table + ".");
    }
    return {
      insert: vi.fn(async (row: Record<string, unknown>) => {
        events.push(row);
        await options.onInsert?.();
        return { error: null };
      }),
    };
  });
  return { sb: { rpc, from } as unknown as SupabaseClient, rpc, from, events };
}

describe("generic campaign action preclaim hold", () => {
  it("treats the disabled runtime switch as an idle state without reading or claiming", async () => {
    const { sb, rpc, from, events } = database();
    const result = await runCampaignActionJob(sb, off, agent, job());
    expect(result).toEqual({ ok: true, retryable: false });
    expect(rpc).not.toHaveBeenCalled();
    expect(from).toHaveBeenCalledExactlyOnceWith("agent_job_events");
    expect(String(events[0]?.description)).toContain("CAMPAIGN_ACTIONS_ENABLED");
  });

  it.each([
    "proof_publish", "page_deploy", "lead_message", "budget_change",
    "meta_ad_build", "google_ad_build", "profile_update", "unknown_action",
  ])("does not claim or execute %s even with the broad switch on", async (actionKey) => {
    const { sb, rpc, from, events } = database();
    const result = await runCampaignActionJob(sb, on, agent, job({
      limit: 20, action_key: actionKey, bypass_preclaim_hold: true,
      approval_id: "forged-approved-version",
    }));

    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      failureMessage: expect.stringContaining(GENERIC_CAMPAIGN_ACTION_CLAIM_HOLD),
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(from).toHaveBeenCalledExactlyOnceWith("agent_job_events");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: "warn" });
    expect(String(events[0]?.description)).toContain("No action was claimed.");
  });

  it("cannot race a support-bit promotion between a registry read and claim", async () => {
    // Pause one sweep after it has entered the hold path, then promote an
    // unhandled key before a second sweep starts. The mock SQL claim would
    // return that newly supported key if either worker called it.
    const registry = { metaAdBuildSupported: false };
    let entered!: () => void;
    let resume!: () => void;
    const firstEventEntered = new Promise<void>((resolve) => { entered = resolve; });
    const resumeFirst = new Promise<void>((resolve) => { resume = resolve; });
    let insertCount = 0;
    const { sb, rpc, from, events } = database({
      registry,
      onInsert: async () => {
        if (++insertCount === 1) {
          entered();
          await resumeFirst;
        }
      },
    });
    const first = runCampaignActionJob(sb, on, agent, job({ action_key: "proof_publish" }));
    await firstEventEntered;
    registry.metaAdBuildSupported = true;
    const second = runCampaignActionJob(sb, on, agent, job({ action_key: "meta_ad_build" }));
    resume();
    const results = await Promise.all([first, second]);

    expect(registry.metaAdBuildSupported).toBe(true);
    expect(results.every((result) => result.ok === false)).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
    expect(from).toHaveBeenCalledTimes(2);
    expect(from).toHaveBeenNthCalledWith(1, "agent_job_events");
    expect(from).toHaveBeenNthCalledWith(2, "agent_job_events");
    expect(events).toHaveLength(2);
  });
});

describe("dormant handler bodies", () => {
  it("has no fallback handler for unknown campaign actions", () => {
    expect(Object.keys(HANDLERS)).toEqual([
      "proof_publish", "page_deploy", "lead_message", "budget_change",
    ]);
    expect(HANDLERS.google_ad_build).toBeUndefined();
    expect(HANDLERS.profile_update).toBeUndefined();
  });

  it("releases only the exact claimed proof execution and preserves skips", async () => {
    const skipped = [{ placement_id: "pl-9", reason: "Payload changed after approval." }];
    const rpc = vi.fn(async () => ({ data: { released: 2, skipped }, error: null }));
    const outcome = await releaseProofPlacements({ rpc } as unknown as SupabaseClient, on, ACTION);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("release_campaign_proof_placements", {
      p_execution_id: ACTION.execution_id,
    });
    expect(outcome.result).toEqual({ released: 2, skipped });
  });

  it("does not call an empty proof release a success", async () => {
    const rpc = vi.fn(async () => ({
      data: { released: 0, skipped: [{ reason: "The placement is retracted." }] },
      error: null,
    }));
    await expect(releaseProofPlacements({ rpc } as unknown as SupabaseClient, on, ACTION))
      .rejects.toMatchObject({
        name: "ActionError", retryable: false,
        message: expect.stringContaining("retracted"),
      });
  });

  it("keeps a failed proof-release transaction retryable", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "serialization failure" } }));
    await expect(releaseProofPlacements({ rpc } as unknown as SupabaseClient, on, ACTION))
      .rejects.toMatchObject({ retryable: true });
  });

  it("enrols only the exact claimed lead-message execution", async () => {
    const rpc = vi.fn(async () => ({
      data: { enrolled: 4, skipped: [], sequence_name: "Objections" }, error: null,
    }));
    const outcome = await enrolCampaignLeads({ rpc } as unknown as SupabaseClient, on, {
      ...ACTION, action_key: "lead_message",
    });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("enrol_campaign_leads_in_sequence_v6", {
      p_execution_id: ACTION.execution_id,
    });
    expect(outcome.result).toMatchObject({ enrolled: 4, sequence: "Objections" });
  });

  it("treats a zero-recipient enrolment as a nonretryable failure", async () => {
    const rpc = vi.fn(async () => ({
      data: { enrolled: 0, skipped: [{ reason: "Unsubscribed." }] }, error: null,
    }));
    await expect(enrolCampaignLeads({ rpc } as unknown as SupabaseClient, on, {
      ...ACTION, action_key: "lead_message",
    })).rejects.toMatchObject({
      name: ActionError.name, retryable: false,
      message: expect.stringContaining("Unsubscribed"),
    });
  });
});
