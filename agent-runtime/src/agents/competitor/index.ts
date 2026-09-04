// Competitor agent.
//
// The one agent form with a genuinely required input: the operator names
// who the competitors are, and everything the Competitors tab renders is
// what this produces. Web search is enabled here — competitor research
// without it would be the model recalling brands, which is exactly the
// failure mode the evidence rules below exist to prevent.
//
// Prompt discipline ported from v5's Competitor OS, which completed 41
// production runs.

import type { SupabaseClient } from "@supabase/supabase-js";
import { anthropicKeyForAgent, type RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { ProviderError, runAgentLoop } from "../../tools/anthropic.js";
import {
  buildSubmitTool,
  findPlaceholders,
  loadDomainContext,
  persistRecords,
  renderContext,
} from "../shared.js";

const DOMAIN = "competitor";

interface Competitor {
  name: string;
  url?: string | null;
}

function readCompetitors(input: Record<string, unknown>): Competitor[] {
  const raw = input.competitors;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (typeof entry === "string") return { name: entry.trim() };
      const record = entry as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name.trim() : "";
      const url = typeof record.url === "string" ? record.url.trim() : null;
      return name ? { name, url } : null;
    })
    .filter((c): c is Competitor => c !== null);
}

const SYSTEM = `You are the evidence-controlled competitor research agent for Attract Acquisition, a marketing agency.

You research a client's named competitors using public sources and produce structured observations for the agency's strategists.

EVIDENCE RULES — these are absolute:
- Use only public, lawfully accessible material. Never log in, bypass access controls, evade platform restrictions, impersonate anyone, or collect private or personal data.
- Paraphrase what you observe. Do not reproduce protected creative work or substantial competitor copy.
- Never invent sources, quotes, prices, performance figures, customers, or results. If something is not publicly observable, say that it is not observable rather than estimating it.
- Distinguish what you observed from what you infer. Mark inference as inference.
- Never describe a finding as verified. Verification is a separate human workflow.

SCOPE:
- Describe observations and patterns. Do not rank winners, recommend a response, prescribe positioning, or turn evidence into strategy — a different agent does that, and doing it here corrupts its input.
- Where evidence is thin, a short honest section is correct. Padding is not.

OUTPUT QUALITY:
- Never write placeholder, filler or stub text ("sample", "placeholder", "n/a", "none", "tbd", "not used") into any section, even under length pressure. A short real sentence is always correct where a placeholder token is never correct.
- If you are running low on output budget, shorten your wording rather than degrading any section.

When you have finished researching, call submit_analysis exactly once with your final structured output. Do not call it before you are done.`;

export async function runCompetitorJob(
  sb: SupabaseClient,
  config: RuntimeConfig,
  agent: AgentRow,
  job: AgentJobRow,
): Promise<JobResult> {
  if (!job.client_id) {
    return { ok: false, retryable: false, failureMessage: "Competitor jobs require a client." };
  }

  const { templates, context, input } = await loadDomainContext(sb, job, DOMAIN);
  const competitors = readCompetitors(input);

  if (competitors.length === 0) {
    // Non-retryable: the operator has to supply this, no amount of
    // retrying conjures a competitor list.
    return {
      ok: false,
      retryable: false,
      failureMessage:
        "No competitors were supplied. Open Competitor Inputs and name at least one competitor.",
    };
  }

  const submitTool = buildSubmitTool(DOMAIN, templates);

  const competitorList = competitors
    .map((c, i) => `${i + 1}. ${c.name}${c.url ? ` — ${c.url}` : ""}`)
    .join("\n");

  const sectionBrief = templates
    .map((t) => `- ${t.item_key}: ${t.title}${t.description ? ` — ${t.description}` : ""}`)
    .join("\n");

  const prompt = `Research these competitors for the client described below.

COMPETITORS TO RESEARCH
${competitorList}

CLIENT CONTEXT
${renderContext(context)}

SECTIONS TO PRODUCE
${sectionBrief}

Research each competitor's public presence, then write each section across the whole competitive set rather than one competitor at a time. Where competitors differ meaningfully, name which competitor a given observation belongs to.

Call ${submitTool.name} once when you are done.`;

  await appendEvent(
    sb,
    job.id,
    `Researching ${competitors.length} competitor${competitors.length === 1 ? "" : "s"}: ${competitors.map((c) => c.name).join(", ")}.`,
  );

  let result;
  try {
    result = await runAgentLoop({
      apiKey: anthropicKeyForAgent(config, agent.agent_key),
      model: config.model,
      system: SYSTEM,
      prompt,
      submitTool,
      enableWebSearch: true,
      maxSearches: 15,
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

  // Degraded output is a failure, not a success with bad data — writing it
  // would poison every downstream agent that reads these records.
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
    domain: DOMAIN,
    jobId: job.id,
    templates,
    sections,
  });

  await appendEvent(
    sb,
    job.id,
    preserved.length > 0
      ? `Wrote ${written} sections. Preserved ${preserved.length} human-edited section(s): ${preserved.join(", ")}.`
      : `Wrote ${written} sections after ${result.turns} turn(s), ${result.usage.webSearches ?? 0} search(es).`,
    "info",
    { searches: result.usage.webSearches, cost_usd: usage.costUsd },
  );

  return { ok: true, retryable: false, usage };
}
