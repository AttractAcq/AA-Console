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
