import { describe, expect, it, vi, beforeEach } from "vitest";

// A minimal stand-in for the SDK. The point of these tests is what happens
// around the provider call, so the provider itself only needs to record that
// it was — or crucially was not — reached.
const { streamMock, ctorMock } = vi.hoisted(() => ({
  streamMock: vi.fn(),
  ctorMock: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {
    status?: number;
  }
  class APIConnectionError extends Error {}
  class Anthropic {
    messages = { stream: streamMock };
    constructor(opts: unknown) {
      ctorMock(opts);
    }
    static APIError = APIError;
    static APIConnectionError = APIConnectionError;
  }
  return { default: Anthropic };
});

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentJobRow } from "../queue.js";
import { AgentBudget, hardBudget, strictUsageUsd } from "../orchestration/hard-budget.js";
import { runAgentLoop, ProviderError } from "./anthropic.js";

const SUBMIT = {
  name: "submit",
  description: "submit",
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
};

const base = {
  apiKey: "k",
  model: "claude-opus-5",
  system: "s",
  prompt: "p",
  submitTool: SUBMIT,
  enableWebSearch: false,
};

/** One assistant turn that calls submit, so a healthy loop terminates. */
function respondsWithSubmit() {
  streamMock.mockReturnValue({
    finalMessage: async () => ({
      content: [{ type: "tool_use", name: "submit", id: "t1", input: { ok: true } }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: "tool_use",
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  respondsWithSubmit();
});

describe("the job deadline", () => {
  // The property that matters: an attempt already past its deadline must not
  // start another model call. Everything else is bookkeeping; this is the
  // money.
  it("does not call the model at all once the deadline has passed", async () => {
    await expect(
      runAgentLoop({ ...base, deadlineAt: Date.now() - 1 }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("fails retryably, because a slow attempt is not an impossible one", async () => {
    const err = await runAgentLoop({ ...base, deadlineAt: Date.now() - 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as ProviderError).message).toMatch(/deadline/i);
  });

  it("runs normally while there is time left", async () => {
    const out = await runAgentLoop({ ...base, deadlineAt: Date.now() + 60_000 });
    expect(out.submitted).toEqual({ ok: true });
    expect(streamMock).toHaveBeenCalledOnce();
  });

  it("still works with no deadline given", async () => {
    const out = await runAgentLoop(base);
    expect(out.submitted).toEqual({ ok: true });
  });

  // A request must not be able to start just inside the deadline and then run
  // for a full provider timeout beyond it.
  it("caps the request signal at whatever time is left, not the full timeout", async () => {
    await runAgentLoop({ ...base, timeoutMs: 600_000, deadlineAt: Date.now() + 5_000 });
    const [, opts] = streamMock.mock.calls[0] as [unknown, { signal: AbortSignal }];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("passes a signal even when the timeout is the tighter bound", async () => {
    await runAgentLoop({ ...base, timeoutMs: 1_000, deadlineAt: Date.now() + 600_000 });
    const [, opts] = streamMock.mock.calls[0] as [unknown, { signal: AbortSignal }];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("an aborted call reads as our deadline, not as a provider fault", () => {
  it("reports the cut-off plainly and retryably", async () => {
    streamMock.mockReturnValue({
      finalMessage: async () => {
        const e = new Error("The operation was aborted due to timeout");
        e.name = "TimeoutError";
        throw e;
      },
    });
    const err = await runAgentLoop({ ...base, deadlineAt: Date.now() + 60_000 }).catch((e) => e);
    expect((err as ProviderError).message).toMatch(/cut off by the job's deadline/i);
    expect((err as ProviderError).retryable).toBe(true);
  });
});

describe("hard-budget Messages dispatch", () => {
  function setup(agent = "icp", policy = "reserved") {
    const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) =>
      ({ data: _name === "client_model_budget_policy" ? policy : null, error: null as { message: string } | null }));
    const budget = new AgentBudget({ rpc } as unknown as SupabaseClient,
      { id: "qa-job", client_id: "qa-client", attempts: 2, agent_key: agent } as AgentJobRow, "worker");
    return { rpc, budget };
  }
  const model = "claude-opus-5";
  it.each(["icp", "brief", "creative_build"])("reserves %s before dispatch and send, disables hidden SDK retries and settles priced usage", async agent => {
    const { rpc, budget } = setup(agent);
    streamMock.mockReturnValue({ finalMessage: async () => ({
      content: [{ type: "tool_use", name: "submit", id: "t", input: { ok: true } }],
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null },
      stop_reason: "tool_use",
    }) });
    await budget.prepare(model);
    await hardBudget.run(budget, () => runAgentLoop({ ...base, model }));
    await budget.finish();
    expect(rpc.mock.calls.map(([name,args]) => [name,args.p_turn,args.p_usd])).toEqual([
      ["reserve_agent_budget_turn",0,7.3536], ["reserve_agent_budget_turn",1,7.3536],
      ["settle_agent_budget_turn",1,0.000175], ["settle_agent_budget_turn",0,0],
    ]);
    expect(rpc.mock.invocationCallOrder[1]).toBeLessThan(streamMock.mock.invocationCallOrder[0]!);
    expect(ctorMock).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0, baseURL: "https://api.anthropic.com" }));
  });
  it("sends nothing if storage refuses the call after dispatch was reserved", async () => {
    const { rpc, budget } = setup();
    await budget.prepare(model);
    rpc.mockRejectedValueOnce(new Error("offline"));
    await expect(hardBudget.run(budget, () => runAgentLoop({ ...base, model }))).rejects.toThrow("could not be verified");
    expect(streamMock).not.toHaveBeenCalled();
  });
  it("retains the sent reservation for an ambiguous provider result", async () => {
    const { rpc, budget } = setup();
    await budget.prepare(model);
    streamMock.mockReturnValue({ finalMessage: async () => { throw new Error("response lost"); } });
    await expect(hardBudget.run(budget, () => runAgentLoop({ ...base, model }))).rejects.toThrow();
    expect(rpc.mock.calls.some(([name,args]) => name.startsWith("settle") && args.p_turn === 1)).toBe(false);
    expect(streamMock).toHaveBeenCalledOnce();
  });
  it("prices Market research before a runner can start", async () => {
    const { rpc, budget } = setup("market");
    await budget.prepare(model);
    expect(rpc).toHaveBeenCalledWith("reserve_agent_budget_turn", expect.objectContaining({ p_usd: 113.0076 }));
    expect(streamMock).not.toHaveBeenCalled();
  });
  it("reserves the selected Market model and settles its search and token usage", async () => {
    const { rpc, budget } = setup("market", "claude-sonnet-4-6");
    const selected = await budget.prepare(model);
    streamMock.mockReturnValue({ finalMessage: async () => ({
      content: [{ type: "tool_use", name: "submit", id: "t", input: { ok: true } }],
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null,
        cache_read_input_tokens: null, server_tool_use: { web_search_requests: 1 } },
      stop_reason: "tool_use",
    }) });
    await hardBudget.run(budget, () => runAgentLoop({ ...base, model: selected, enableWebSearch: true, maxSearches: 15 }));
    expect(streamMock.mock.calls[0]?.[0]).toMatchObject({
      model: "claude-sonnet-4-6", tools: expect.arrayContaining([expect.objectContaining({ max_uses: 15 })]),
    });
    expect(rpc.mock.calls.slice(1).map(([name, args]) => [name, args.p_turn, args.p_usd])).toEqual([
      ["reserve_agent_budget_turn", 0, 67.86456], ["reserve_agent_budget_turn", 1, 67.86456],
      ["settle_agent_budget_turn", 1, 0.010105],
    ]);
  });

  it.each(["reserved", "claude-sonnet-4-6", "unknown", null])("holds direct routes on policy %s", async policy => {
    const rpc = vi.fn(async () => ({ data: policy, error: null }));
    await expect(runAgentLoop({ ...base, directClient: { db: { rpc } as unknown as SupabaseClient, id: "client" } }))
      .rejects.toThrow(/budget|reserved/);
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("settles cache writes at their actual TTLs and retains an unitemized charge", () => {
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 10, cache_read_input_tokens: 0,
      server_tool_use: null, cache_creation: { ephemeral_5m_input_tokens: 8, ephemeral_1h_input_tokens: 2 } };
    expect(strictUsageUsd("claude-sonnet-4-6", usage, false)).toBe(0.000042);
    expect(() => strictUsageUsd(model, { ...usage, cache_creation: null }, false)).toThrow(/reservation retained/);
  });
});

it("preserves an unknown full charge when provider usage is missing", async () => {
  const rpc = vi.fn(async () => ({ data: null, error: null }));
  const budget = new AgentBudget({ rpc } as unknown as SupabaseClient,
    { id: "incomplete", client_id: "qa-client", attempts: 1, agent_key: "icp" } as AgentJobRow, "worker");
  await budget.prepare("claude-opus-5");
  // The default mock response omits the cache-usage fields.
  await expect(hardBudget.run(budget, () => runAgentLoop({ ...base, model: "claude-opus-5" })))
    .rejects.toThrow("Incomplete provider usage");
  expect(rpc).toHaveBeenCalledTimes(2);
});
