import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../config.js";
import type { AgentRow } from "../orchestration/registry.js";
import type { AgentJobRow } from "../queue.js";
import { runMetaBuildJob } from "../agents/meta_build/index.js";
import { runRecruitmentMetaBuildJob } from "../agents/recruitment_meta_build/index.js";

const CLIENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CAMPAIGN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT = {} as AgentRow;
const CONFIG = {} as RuntimeConfig;

function database() {
  return {
    from: vi.fn(),
    rpc: vi.fn(),
    storage: { from: vi.fn() },
  } as unknown as SupabaseClient;
}

function job(agentKey: string, inputTable: string, params: Record<string, unknown> = {}) {
  return {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    agent_key: agentKey,
    client_id: CLIENT,
    input_table: inputTable,
    input_id: CAMPAIGN,
    params,
  } as AgentJobRow;
}

afterEach(() => vi.restoreAllMocks());

describe("Meta object creation containment before the AAL2 prewrite gate", () => {
  it.each([
    ["generic authenticated enqueue or request_meta_build", {}],
    ["a forged v6 execution binding in a generic job", {
      campaign_action_execution_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      campaign_action_approval_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    }],
  ])("blocks the client Meta runner for %s before credentials or provider calls", async (_route, params) => {
    const sb = database();
    const provider = vi.spyOn(globalThis, "fetch");
    const writer = vi.fn();
    const currency = vi.fn();
    const result = await runMetaBuildJob(sb, CONFIG, AGENT,
      job("meta_build", "client_campaigns", params), undefined,
      { writer, currency });

    expect(result).toMatchObject({
      ok: false, retryable: false,
      failureMessage: expect.stringMatching(/exact-version AAL2 Approval Inbox decision/),
    });
    expect(sb.from).not.toHaveBeenCalled();
    expect(sb.rpc).not.toHaveBeenCalled();
    expect(sb.storage.from).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
    expect(currency).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it("blocks recruitment Meta jobs from generic enqueue and auto-enqueue before provider calls", async () => {
    const sb = database();
    const provider = vi.spyOn(globalThis, "fetch");
    const writer = vi.fn();
    const currency = vi.fn();
    const result = await runRecruitmentMetaBuildJob(sb, CONFIG, AGENT,
      job("recruitment_meta_build", "recruitment_meta_campaigns"), undefined,
      { writer, currency });

    expect(result).toMatchObject({
      ok: false, retryable: false,
      failureMessage: expect.stringMatching(/exact-version AAL2 Approval Inbox decision/),
    });
    expect(sb.from).not.toHaveBeenCalled();
    expect(sb.rpc).not.toHaveBeenCalled();
    expect(sb.storage.from).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
    expect(currency).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });
});
