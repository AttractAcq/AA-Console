import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { classifyProviderError } from "./anthropic.js";

describe("Anthropic transport errors", () => {
  it("retries an SDK abort even though it inherits from APIError", () => {
    const error = new Anthropic.APIUserAbortError({ message: "Request was aborted." });
    expect(classifyProviderError(error).retryable).toBe(true);
  });

  it("retries a status-zero API error with no HTTP response", () => {
    const error = new Anthropic.APIError(0, undefined, "Request was aborted.", undefined);
    expect(classifyProviderError(error).retryable).toBe(true);
  });
});
