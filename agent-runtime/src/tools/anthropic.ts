// Anthropic client and tool loop.
//
// Deliberately a hand-rolled loop over the official SDK rather than the
// SDK's tool runner: an agent here does server-tool research and then hands
// back one structured payload, and owning the loop is what lets us cap
// turns, repair history, and classify failures for the retry decision.
//
// STREAMING IS NOT OPTIONAL. Non-streaming requests with web_search time
// out against the HTTP timeout while the server tool works — this was a
// live failure in the v5 runtime (PROVIDER_TIMEOUT), and the SDK gives the
// same guidance independently for large max_tokens.

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../logging/logger.js";
import { estimateCostUsd, type TokenUsage } from "../usage/cost.js";

export interface SubmitToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AgentLoopOptions {
  apiKey: string;
  /** Per-request timeout. Defaults to ten minutes if a caller omits it. */
  timeoutMs?: number;
  model: string;
  system: string;
  prompt: string;
  submitTool: SubmitToolSpec;
  enableWebSearch: boolean;
  maxTurns?: number;
  maxSearches?: number;
  onProgress?: (note: string) => void;
}

export interface AgentLoopResult {
  submitted: Record<string, unknown>;
  usage: TokenUsage & { costUsd: number };
  turns: number;
}

/** Thrown for anything the caller may want to classify as retryable. */
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly usage: (TokenUsage & { costUsd: number }) | null;

  constructor(message: string, retryable: boolean, usage: (TokenUsage & { costUsd: number }) | null = null) {
    super(message);
    this.name = "ProviderError";
    this.retryable = retryable;
    this.usage = usage;
  }
}

function classify(error: unknown): { message: string; retryable: boolean } {
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    // 4xx other than 429 means we sent something wrong — retrying sends
    // exactly the same thing, so it will fail identically.
    const retryable = status === 429 || status >= 500 || status === 408;
    return { message: `Anthropic ${status}: ${error.message}`, retryable };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { message: `Connection error: ${error.message}`, retryable: true };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { message, retryable: /timeout|timed out|econnreset|socket/i.test(message) };
}

type Blocks = Anthropic.Messages.ContentBlockParam[];

/**
 * The API rejects a history in which a client tool_use is never answered,
 * which happens when a turn ends on pause_turn or max_tokens mid-call.
 * Server tools (web_search) carry their own results in the same message
 * and must be left alone.
 */
function answerDanglingToolUses(messages: Anthropic.Messages.MessageParam[]): void {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant" || typeof last.content === "string") return;

  const unanswered = (last.content as Blocks)
    .filter((block): block is Anthropic.Messages.ToolUseBlockParam => block.type === "tool_use")
    .map((block) => block.id);
  if (unanswered.length === 0) return;

  messages.push({
    role: "user",
    content: unanswered.map((id) => ({
      type: "tool_result" as const,
      tool_use_id: id,
      content: "This call did not complete because the previous turn ended early. Continue without it.",
      is_error: true,
    })),
  });
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    apiKey,
    model,
    system,
    prompt,
    submitTool,
    enableWebSearch,
    maxTurns = 12,
    maxSearches = 12,
    onProgress,
  } = options;

  // Without a timeout the SDK waits indefinitely, and a stalled stream then
  // hangs the whole job: the lease keeps being renewed by a live process, so
  // the expiry that is supposed to recover a wedged job never fires. This is
  // the bound that makes the call eventually fail instead.
  const timeoutMs = options.timeoutMs ?? 600_000;
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: timeoutMs });

  const tools: Anthropic.Messages.ToolUnion[] = [
    {
      name: submitTool.name,
      description: submitTool.description,
      input_schema: submitTool.inputSchema as Anthropic.Messages.Tool.InputSchema,
      // Guarantees the arguments validate against the schema, so the
      // persistence layer never has to defend against a malformed payload.
      strict: true,
    } as Anthropic.Messages.ToolUnion,
  ];

  if (enableWebSearch) {
    tools.unshift({
      type: "web_search_20260209",
      name: "web_search",
      max_uses: maxSearches,
    } as unknown as Anthropic.Messages.ToolUnion);
  }

  const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: prompt }];
  const totals: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    webSearches: 0,
  };

  const usageWithCost = () => ({ ...totals, costUsd: estimateCostUsd(model, totals) });

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    let response: Anthropic.Messages.Message;
    try {
      const stream = client.messages.stream({
        model,
        max_tokens: 32000,
        system,
        messages,
        tools,
        // Adaptive is the only thinking mode on Opus 5; budget_tokens is
        // rejected. Effort defaults to high.
        thinking: { type: "adaptive" },
      });
      response = await stream.finalMessage();
    } catch (error) {
      const { message, retryable } = classify(error);
      throw new ProviderError(message, retryable, usageWithCost());
    }

    totals.inputTokens += response.usage.input_tokens ?? 0;
    totals.outputTokens += response.usage.output_tokens ?? 0;
    totals.cacheReadTokens = (totals.cacheReadTokens ?? 0) + (response.usage.cache_read_input_tokens ?? 0);
    totals.cacheWriteTokens = (totals.cacheWriteTokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0);
    const searches = (response.usage as { server_tool_use?: { web_search_requests?: number } })
      .server_tool_use?.web_search_requests;
    if (typeof searches === "number") totals.webSearches = (totals.webSearches ?? 0) + searches;

    logger.info("anthropic_turn", {
      turn,
      stopReason: response.stop_reason,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    });

    // A policy decline is not something a retry fixes.
    if (response.stop_reason === "refusal") {
      throw new ProviderError(
        `Model declined the request (${response.stop_details?.category ?? "unspecified"}).`,
        false,
        usageWithCost(),
      );
    }

    const submitCall = response.content.find(
      (block): block is Anthropic.Messages.ToolUseBlock =>
        block.type === "tool_use" && block.name === submitTool.name,
    );
    if (submitCall) {
      return {
        submitted: submitCall.input as Record<string, unknown>,
        usage: usageWithCost(),
        turns: turn,
      };
    }

    messages.push({ role: "assistant", content: response.content as Blocks });

    if (response.stop_reason === "pause_turn") {
      // Server tool work paused mid-flight; resend to resume it.
      onProgress?.(`Research paused and resumed (turn ${turn}).`);
      continue;
    }

    if (response.stop_reason === "end_turn") {
      // It stopped without submitting. Nudge once rather than looping in
      // silence — this is usually the model finishing research and needing
      // to be told to produce the payload.
      answerDanglingToolUses(messages);
      messages.push({
        role: "user",
        content: `You have not yet called ${submitTool.name}. Do that now with your final structured output, using only what you actually found.`,
      });
      continue;
    }

    if (response.stop_reason === "max_tokens") {
      answerDanglingToolUses(messages);
      messages.push({
        role: "user",
        content: `That response hit the length limit. Call ${submitTool.name} now with a more concise version — shorten wording, do not drop sections.`,
      });
      continue;
    }

    answerDanglingToolUses(messages);
  }

  throw new ProviderError(
    `Agent did not call ${submitTool.name} within ${maxTurns} turns.`,
    true,
    usageWithCost(),
  );
}
