// OpenAI text generation, for the creative-director stage.
//
// Hand-rolled against the Responses API rather than pulling the SDK: this
// runtime makes one kind of call to OpenAI for text and one for images, and
// a dependency to reach either would outweigh both.
//
// Structured output is requested as a strict json_schema so the concept
// comes back parseable, the same guarantee the Anthropic path gets from a
// tool schema.

import { logger } from "../logging/logger.js";
import type { TokenUsage } from "../usage/cost.js";

const ENDPOINT = "https://api.openai.com/v1/responses";
const TIMEOUT_MS = 300_000;

export class OpenAiError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "OpenAiError";
    this.retryable = retryable;
  }
}

export interface StructuredResult {
  parsed: Record<string, unknown>;
  usage: TokenUsage;
}

/**
 * The response shape varies by model and version, so the text is pulled
 * defensively: output_text when the API provides the convenience field,
 * otherwise the first text content found in the output array.
 */
function extractText(body: Record<string, unknown>): string {
  if (typeof body.output_text === "string" && body.output_text.trim()) {
    return body.output_text;
  }
  const output = body.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string" && text.trim()) return text;
      }
    }
  }
  return "";
}

export async function runStructuredCompletion(opts: {
  apiKey: string;
  model: string;
  system: string;
  prompt: string;
  schemaName: string;
  schema: Record<string, unknown>;
  reasoningEffort?: "low" | "medium" | "high";
}): Promise<StructuredResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model,
        input: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.prompt },
        ],
        reasoning: { effort: opts.reasoningEffort ?? "medium" },
        text: {
          format: {
            type: "json_schema",
            name: opts.schemaName,
            strict: true,
            schema: opts.schema,
          },
        },
      }),
    });

    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;

    if (!response.ok) {
      const error = body?.error as { message?: string } | undefined;
      const message = error?.message ?? `OpenAI returned ${response.status}`;
      // 400 usually means the model id or the schema is wrong; retrying
      // sends exactly the same thing.
      const retryable = response.status === 429 || response.status >= 500;
      throw new OpenAiError(
        response.status === 404
          ? `${message} (check CREATIVE_CONCEPT_MODEL — "${opts.model}" was not found)`
          : message,
        retryable,
      );
    }
    if (!body) throw new OpenAiError("OpenAI returned an empty response.", true);

    const text = extractText(body);
    if (!text) throw new OpenAiError("OpenAI returned no content.", true);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      logger.error("openai_unparseable_json", { model: opts.model, sample: text.slice(0, 200) });
      throw new OpenAiError("The model did not return valid JSON.", true);
    }

    const usage = (body.usage ?? {}) as Record<string, unknown>;
    return {
      parsed,
      usage: {
        inputTokens: Number(usage.input_tokens ?? 0),
        outputTokens: Number(usage.output_tokens ?? 0),
      },
    };
  } catch (error) {
    if (error instanceof OpenAiError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new OpenAiError(`Could not reach OpenAI: ${message}`, true);
  } finally {
    clearTimeout(timer);
  }
}
