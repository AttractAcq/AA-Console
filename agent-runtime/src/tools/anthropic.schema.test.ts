import { describe, expect, it, vi, beforeEach } from "vitest";

// Same stand-in as the deadline suite: what matters here is whether the
// provider was reached at all, not what it would have said.
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

const base = {
  apiKey: "k",
  model: "claude-opus-5",
  system: "s",
  prompt: "p",
  enableWebSearch: false,
};

function submitWith(properties: Record<string, unknown>) {
  return {
    name: "submit_campaign_plan",
    description: "submit",
    inputSchema: { type: "object", properties, required: [], additionalProperties: false },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  streamMock.mockReturnValue({
    finalMessage: async () => ({
      content: [{ type: "tool_use", name: "submit_campaign_plan", id: "t1", input: { ok: true } }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: "tool_use",
    }),
  });
}); 

// The Campaign Planner shipped a schema the API refuses, and the only signal
// was a 400 naming a keyword — no agent, no property, and a full paid round
// trip to discover it. Checking first turns that into a sentence.
describe("a submit schema the API would refuse", () => {
  const bad = submitWith({ ideas: { type: "array", maxItems: 30, items: { type: "object" } } });

  it("never reaches the provider", async () => {
    await expect(runAgentLoop({ ...base, submitTool: bad })).rejects.toBeInstanceOf(ProviderError);
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("is not retryable, because retrying sends the same schema", async () => {
    const err = await runAgentLoop({ ...base, submitTool: bad }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
  });

  it("names the agent, the property and the remedy", async () => {
    const err = await runAgentLoop({ ...base, submitTool: bad }).catch((e) => e);
    const message = (err as Error).message;
    expect(message).toContain("submit_campaign_plan");
    expect(message).toContain("properties.ideas.maxItems");
    expect(message).toMatch(/enforce the constraint in code/i);
  });

  it("reports every offending keyword at once", async () => {
    const worse = submitWith({
      ideas: { type: "array", maxItems: 30, items: { type: "string", minLength: 1 } },
    });
    const err = await runAgentLoop({ ...base, submitTool: worse }).catch((e) => e);
    expect((err as Error).message).toContain("properties.ideas.maxItems");
    expect((err as Error).message).toContain("properties.ideas.items.minLength");
  });
});

describe("a submit schema within the supported subset", () => {
  it("is sent, and the loop runs normally", async () => {
    const good = submitWith({
      ideas: {
        type: "array",
        items: { type: "object", properties: { title: { type: "string" } } },
      },
    });
    const out = await runAgentLoop({ ...base, submitTool: good });
    expect(streamMock).toHaveBeenCalled();
    expect(out.submitted).toEqual({ ok: true });
  });
});
