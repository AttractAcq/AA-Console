// One runner shape for every record-producing domain.
//
// The competitor agent proved the sequence — load context, build a
// template-driven submit tool, run the loop, reject placeholders, persist
// while preserving human edits. Everything except the prompt is identical
// across domains, so it lives here once. v5 shipped three parallel copies
// of this pattern across ~2,300 lines; this is the deliberate alternative.

import type { SupabaseClient } from "@supabase/supabase-js";
import { anthropicKeyForAgent, type RuntimeConfig } from "../config.js";
import type { AgentRow } from "../orchestration/registry.js";
import type { JobResult, JobRunner } from "../orchestration/dispatch.js";
import type { AgentJobRow } from "../queue.js";
import { appendEvent } from "../queue.js";
import { ProviderError, runAgentLoop } from "../tools/anthropic.js";
import {
  buildSubmitTool,
  findPlaceholders,
  loadDomainContext,
  loadUpstreamRecords,
  persistRecords,
  renderContext,
  renderUpstream,
  type BusinessContext,
  type Template,
  type UpstreamRecord,
} from "./shared.js";

export interface PromptArgs {
  templates: Template[];
  context: BusinessContext | null;
  input: Record<string, unknown>;
  upstream: UpstreamRecord[];
  /** The sections the model must return, already formatted for a prompt. */
  sectionBrief: string;
  submitToolName: string;
}

export interface RecordAgentConfig {
  domain: string;
  system: string;
  buildPrompt: (args: PromptArgs) => string;
  enableWebSearch?: boolean;
  maxSearches?: number;
  /** Domains whose records this agent synthesises from. */
  upstreamDomains?: string[];
  /** Return an error message to fail non-retryably before spending a token. */
  validate?: (input: Record<string, unknown>) => string | null;
  /** Campaign Intelligence is the one domain whose records carry a period. */
  resolvePeriod?: (input: Record<string, unknown>) => string | null;
  /** Opening line for the job event log. */
  describeStart?: (input: Record<string, unknown>) => string;
}

export function createRecordAgent(config: RecordAgentConfig): JobRunner {
  return async function run(
    sb: SupabaseClient,
    runtime: RuntimeConfig,
    agent: AgentRow,
    job: AgentJobRow,
  ): Promise<JobResult> {
    if (!job.client_id) {
      return { ok: false, retryable: false, failureMessage: `${config.domain} jobs require a client.` };
    }

    const { templates, context, input } = await loadDomainContext(sb, job, config.domain);

    // Cheapest possible failure: before any provider call.
    const invalid = config.validate?.(input);
    if (invalid) {
      return { ok: false, retryable: false, failureMessage: invalid };
    }

    const upstreamDomains = config.upstreamDomains ?? [];
    const upstream = await loadUpstreamRecords(sb, job.client_id, upstreamDomains);
    if (upstreamDomains.length > 0 && upstream.length === 0) {
      // The database gate should have prevented this, so it means the
      // upstream records were deleted after the job was queued.
      return {
        ok: false,
        retryable: false,
        failureMessage: `No ${upstreamDomains.join(", ")} records exist for this client. Run those agents first.`,
      };
    }

    const submitTool = buildSubmitTool(config.domain, templates);
    const sectionBrief = templates
      .map((t) => `- ${t.item_key}: ${t.title}${t.description ? ` — ${t.description}` : ""}`)
      .join("\n");

    const prompt = config.buildPrompt({
      templates,
      context,
      input,
      upstream,
      sectionBrief,
      submitToolName: submitTool.name,
    });

    if (config.describeStart) {
      await appendEvent(sb, job.id, config.describeStart(input));
    }

    let result;
    try {
      result = await runAgentLoop({
        apiKey: anthropicKeyForAgent(runtime, agent.agent_key),
        model: runtime.model,
        system: config.system,
        prompt,
        submitTool,
        enableWebSearch: config.enableWebSearch ?? false,
        maxSearches: config.maxSearches ?? 12,
        onProgress: (note) => void appendEvent(sb, job.id, note),
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        return {
          ok: false,
          retryable: error.retryable,
          failureMessage: error.message,
          usage: error.usage
            ? {
                inputTokens: error.usage.inputTokens,
                outputTokens: error.usage.outputTokens,
                costUsd: error.usage.costUsd,
              }
            : undefined,
        };
      }
      throw error;
    }

    const sections = result.submitted as Record<string, string>;
    const usage = {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: result.usage.costUsd,
    };

    // Degraded output is a failure, not a success with bad data — writing
    // it would poison every downstream agent that reads these records.
    const placeholders = findPlaceholders(sections);
    if (placeholders.length > 0) {
      return {
        ok: false,
        retryable: true,
        failureMessage: `Model returned empty or placeholder content for: ${placeholders.join(", ")}.`,
        usage,
      };
    }

    const { written, preserved } = await persistRecords(sb, {
      clientId: job.client_id,
      domain: config.domain,
      jobId: job.id,
      templates,
      sections,
      period: config.resolvePeriod?.(input) ?? null,
    });

    await appendEvent(
      sb,
      job.id,
      preserved.length > 0
        ? `Wrote ${written} sections. Preserved ${preserved.length} human-edited section(s): ${preserved.join(", ")}.`
        : `Wrote ${written} sections after ${result.turns} turn(s)${result.usage.webSearches ? `, ${result.usage.webSearches} search(es)` : ""}.`,
      "info",
      { searches: result.usage.webSearches, cost_usd: usage.costUsd },
    );

    return { ok: true, retryable: false, usage };
  };
}

/** Shared opening every domain's system prompt builds on. */
export const HOUSE_RULES = `You work for Attract Acquisition, a marketing agency, producing structured intelligence its strategists rely on.

Absolute rules:
- Never invent facts, quotes, figures, customers or results. Where something is not knowable from what you have been given, say so plainly instead of estimating.
- Distinguish what you were told from what you infer. Mark inference as inference.
- Never write placeholder, filler or stub text ("sample", "placeholder", "n/a", "none", "tbd") into any section, even under length pressure. A short real sentence is always correct where a placeholder token is never correct. If you are short on output budget, shorten your wording rather than degrading any section.
- Write for a strategist who will act on this. Be specific and concrete. Generic marketing language that would apply to any business is worthless here.`;
