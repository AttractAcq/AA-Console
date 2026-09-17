import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();

vi.stubGlobal("fetch", fetchMock);

import { runStructuredCompletion, OpenAiError } from "./openai.js";

const base = {
  apiKey: "k",
  model: "gpt-test",
  system: "s",
  prompt: "p",
  schemaName: "submit_concept",
};

const completeSchema = {
  type: "object",
  properties: { subject: { type: "string" }, background: { type: "string" } },
  required: ["subject", "background"],
  additionalProperties: false,
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ output_text: JSON.stringify({ ok: true }), usage: {} }),
  });
});

afterEach(() => {
  fetchMock.mockReset();
});

// Same class of outage as PR #51: the schema is refused before a token is
// spent, the 400 names a missing required key rather than an agent, and
// retrying sends exactly the same schema.
describe("a structured schema OpenAI would refuse", () => {
  const incomplete = {
    type: "object",
    properties: { subject: { type: "string" }, background: { type: "string" } },
    required: ["subject"],
    additionalProperties: false,
  };

  it("never reaches the provider", async () => {
    await expect(runStructuredCompletion({ ...base, schema: incomplete })).rejects.toBeInstanceOf(
      OpenAiError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is not retryable, because retrying sends the same schema", async () => {
    const err = await runStructuredCompletion({ ...base, schema: incomplete }).catch((e) => e);
    expect(err).toBeInstanceOf(OpenAiError);
    expect((err as OpenAiError).retryable).toBe(false);
  });

  it("names the schema and the missing key, matching the production 400", async () => {
    const err = await runStructuredCompletion({ ...base, schema: incomplete }).catch((e) => e);
    const message = (err as Error).message;
    expect(message).toContain("submit_concept");
    expect(message).toMatch(/Missing 'background'/);
  });
});

describe("a structured schema within the supported subset", () => {
  it("is sent, and the completion runs normally", async () => {
    const out = await runStructuredCompletion({ ...base, schema: completeSchema });
    expect(fetchMock).toHaveBeenCalled();
    expect(out.parsed).toEqual({ ok: true });
  });
});
