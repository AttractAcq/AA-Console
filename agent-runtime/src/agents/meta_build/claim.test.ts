import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { AgentJobRow } from "../../queue.js";
import { v6MetaBuildClaimProblem } from "./claim.js";
import { runMetaBuildJob } from "./index.js";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const EXECUTION = "44444444-4444-4444-8444-444444444444";
const APPROVAL = "55555555-5555-4555-8555-555555555555";
const MANIFEST = "66666666-6666-4666-8666-666666666666";
const HASH = "a".repeat(64);

const campaign = {
  id: CAMPAIGN,
  client_id: CLIENT,
  acquisition_mode: "paid",
  paid_platform: "meta",
};
const job = {
  id: JOB,
  agent_key: "meta_build",
  client_id: CLIENT,
  input_table: "client_campaigns",
  input_id: CAMPAIGN,
  params: {
    campaign_action_execution_id: EXECUTION,
    campaign_action_approval_id: APPROVAL,
  },
  status: "running",
  attempts: 1,
  max_attempts: 3,
  lease_owner: "worker-1",
  lease_until: "2099-01-01T00:00:00Z",
} satisfies AgentJobRow;

const execution = {
  id: EXECUTION,
  approval_id: APPROVAL,
  client_id: CLIENT,
  campaign_id: CAMPAIGN,
  action_key: "meta_ad_build",
  artifact_version_hash: HASH,
  manifest_id: MANIFEST,
  status: "executing",
  lease_until: "2099-01-01T00:00:00Z",
  meta_build_job_id: JOB,
};
const approval = {
  id: APPROVAL,
  client_id: CLIENT,
  campaign_id: CAMPAIGN,
  manifest_id: MANIFEST,
  action_key: "meta_ad_build",
  artifact_version_hash: HASH,
  status: "approved",
  destination: "meta:act_42",
  scope: { ad_account: "act_42" },
};

type Fixture = {
  execution?: Record<string, unknown> | null;
  approval?: Record<string, unknown> | null;
  integration?: Record<string, unknown> | null;
  allowedApprovalId?: string | null;
  gateError?: string;
};

function database(overrides: Fixture = {}) {
  const rows: Record<string, unknown> = {
    campaign_action_executions: overrides.execution === undefined ? execution : overrides.execution,
    campaign_action_approvals: overrides.approval === undefined ? approval : overrides.approval,
    client_integrations: overrides.integration === undefined
      ? { ad_account_id: "act_42" } : overrides.integration,
  };
  const reads: string[] = [];
  const from = vi.fn((table: string) => {
    reads.push(table);
    if (!(table in rows)) throw new Error(`Unexpected read of ${table}`);
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: rows[table], error: null }),
    };
    return query;
  });
  const rpc = vi.fn(async (name: string) => {
    if (name !== "assert_meta_build_allowed_v6") throw new Error(`Unexpected RPC ${name}`);
    return overrides.gateError
      ? { data: null, error: { message: overrides.gateError } }
      : { data: overrides.allowedApprovalId === undefined ? APPROVAL : overrides.allowedApprovalId, error: null };
  });
  return { sb: { from, rpc } as unknown as SupabaseClient, from, rpc, reads };
}

describe("v6 Meta build claim", () => {
  it("refuses missing or malformed claim IDs without any database call", async () => {
    for (const params of [null, {}, { ...job.params, campaign_action_execution_id: "not-a-uuid" },
      { ...job.params, campaign_action_approval_id: null }]) {
      const db = database();
      expect(await v6MetaBuildClaimProblem(db.sb, { ...job, params } as AgentJobRow, campaign))
        .toMatch(/no exact campaign action execution and approval binding/);
      expect(db.from).not.toHaveBeenCalled();
      expect(db.rpc).not.toHaveBeenCalled();
    }
  });

  it("refuses a campaign outside the paid Meta route before reading a claim", async () => {
    const db = database();
    expect(await v6MetaBuildClaimProblem(db.sb, job, { ...campaign, paid_platform: "google" }))
      .toMatch(/Only a paid Meta campaign/);
    expect(db.from).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong approval", { approval_id: CAMPAIGN }],
    ["wrong client", { client_id: CAMPAIGN }],
    ["wrong campaign", { campaign_id: CLIENT }],
    ["wrong action", { action_key: "page_deploy" }],
    ["already executed", { status: "executed" }],
    ["expired lease", { lease_until: "2000-01-01T00:00:00Z" }],
    ["wrong job binding", { meta_build_job_id: CAMPAIGN }],
    ["missing job binding", { meta_build_job_id: null }],
  ])("refuses %s on the execution before reading credentials", async (_name, changed) => {
    const db = database({ execution: { ...execution, ...changed } });
    expect(await v6MetaBuildClaimProblem(db.sb, job, campaign))
      .toMatch(/not bound to a current, claimed execution/);
    expect(db.reads).toEqual(["campaign_action_executions"]);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong manifest", { manifest_id: CAMPAIGN }],
    ["wrong payload", { artifact_version_hash: "b".repeat(64) }],
    ["unapproved", { status: "pending" }],
    ["wrong client", { client_id: CAMPAIGN }],
  ])("refuses %s on the approval before reading credentials", async (_name, changed) => {
    const db = database({ approval: { ...approval, ...changed } });
    expect(await v6MetaBuildClaimProblem(db.sb, job, campaign))
      .toMatch(/does not match an approved version/);
    expect(db.reads).toEqual(["campaign_action_executions", "campaign_action_approvals"]);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["account changed", { integration: { ad_account_id: "act_99" } }],
    ["approval destination changed", { approval: { ...approval, destination: "meta:act_99" } }],
    ["scope changed", { approval: { ...approval, scope: { ad_account: "act_99" } } }],
  ])("refuses %s before the live gate", async (_name, overrides) => {
    const db = database(overrides);
    expect(await v6MetaBuildClaimProblem(db.sb, job, campaign)).toMatch(/exact destination/);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("passes the same claimed approval to migration 239's live gate", async () => {
    const db = database();
    expect(await v6MetaBuildClaimProblem(db.sb, job, campaign)).toBeNull();
    expect(db.reads).toEqual([
      "campaign_action_executions", "campaign_action_approvals", "client_integrations",
    ]);
    expect(db.rpc).toHaveBeenCalledWith("assert_meta_build_allowed_v6", { p_campaign_id: CAMPAIGN });
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });

  it("refuses a newer approval or a live gate refusal", async () => {
    const newer = database({ allowedApprovalId: CAMPAIGN });
    expect(await v6MetaBuildClaimProblem(newer.sb, job, campaign))
      .toMatch(/not the one claimed by this job/);
    const stale = database({ gateError: "The build changed after it was approved." });
    expect(await v6MetaBuildClaimProblem(stale.sb, job, campaign))
      .toMatch(/build changed/);
  });
});

describe("Meta runner boundary", () => {
  it("stops a v6 job without claim context before credentials, currency or provider writes", async () => {
    const from = vi.fn((table: string) => {
      if (table !== "client_campaigns") throw new Error(`Unexpected read of ${table}`);
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: campaign, error: null }),
      };
      return query;
    });
    const rpc = vi.fn();
    const writer = vi.fn();
    const currency = vi.fn();
    const result = await runMetaBuildJob(
      { from, rpc } as unknown as SupabaseClient,
      {} as RuntimeConfig, {} as AgentRow, { ...job, params: null }, undefined,
      { writer, currency },
    );
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(result.failureMessage).toMatch(/no exact campaign action execution/);
    expect(from).toHaveBeenCalledTimes(1);
    expect(rpc).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
    expect(currency).not.toHaveBeenCalled();
  });

  it("preserves the existing legacy path without consulting the v6 claim", async () => {
    const from = vi.fn((table: string) => {
      if (table === "client_campaigns") {
        const query = {
          select: () => query,
          eq: () => query,
          maybeSingle: async () => ({ data: { ...campaign, acquisition_mode: "legacy" }, error: null }),
        };
        return query;
      }
      if (table === "agent_jobs") {
        const query = {
          select: () => query,
          eq: () => query,
          in: () => query,
          neq: () => query,
          limit: async () => ({ data: [{ id: "another-build" }], error: null }),
        };
        return query;
      }
      throw new Error(`Unexpected read of ${table}`);
    });
    const rpc = vi.fn();
    const result = await runMetaBuildJob(
      { from, rpc } as unknown as SupabaseClient,
      {} as RuntimeConfig, {} as AgentRow, { ...job, params: null },
    );
    expect(result).toMatchObject({ ok: false, retryable: true });
    expect(from.mock.calls.map(([table]) => table))
      .toEqual(["client_campaigns", "agent_jobs"]);
    expect(rpc).not.toHaveBeenCalled();
  });
});
