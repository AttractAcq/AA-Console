// Sales Agent Builder.
//
// Tool 2 writes the page; this writes the thing standing on it. Same shape as
// the page builder deliberately: one button on the console gathers everything
// the business knows and hands it over, and what comes back is displayed
// rather than retyped.
//
// The difference is what "wrong" costs. A bad page is bad copy. A bad sales
// agent is a machine repeating an invented promise to a client's own customers
// at whatever rate the client sends traffic — so the offer's stated limits
// arrive as hard guardrails, and only cleared proof is quotable.

import type { SupabaseClient } from "@supabase/supabase-js";
import { anthropicKeyForAgent, type RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { ProviderError, runAgentLoop } from "../../tools/anthropic.js";
import { loadUpstreamRecords, renderContext, renderUpstream } from "../shared.js";
import type { BusinessContext } from "../shared.js";
import { loadPagePackage, renderPackage } from "../landing_page/aggregate.js";
import {
  definitionProblem,
  definitionSummary,
  normaliseObjections,
  normaliseQualification,
  MIN_QUALIFICATION,
  type SalesAgentDefinition,
} from "./definition.js";

export async function runSalesAgentJob(
  sb: SupabaseClient,
  runtime: RuntimeConfig,
  agent: AgentRow,
  job: AgentJobRow,
  deadlineAt: number,
): Promise<JobResult> {
  if (!job.client_id) {
    return { ok: false, retryable: false, failureMessage: "Sales agent jobs require a client." };
  }
  if (job.input_table !== "client_sales_agents" || !job.input_id) {
    return {
      ok: false,
      retryable: false,
      failureMessage: "This agent builds a sales agent created by Build Sales Agent — it has nothing to work on.",
    };
  }

  const { data: row, error: rowError } = await sb
    .from("client_sales_agents")
    .select("id, name, purpose, page_id")
    .eq("id", job.input_id)
    .maybeSingle();
  if (rowError) throw new Error(`Failed to load sales agent: ${rowError.message}`);
  if (!row) {
    return { ok: false, retryable: false, failureMessage: "That sales agent no longer exists." };
  }
  if (!row.purpose || row.purpose.trim().length === 0) {
    return {
      ok: false,
      retryable: false,
      failureMessage: "The sales agent has no purpose. Say what it is for and try again.",
    };
  }

  const { data: clientRow } = await sb
    .from("clients")
    .select("name")
    .eq("id", job.client_id)
    .maybeSingle();
  const clientName = (clientRow?.name as string | undefined) ?? "this business";

  const [{ data: context }, records] = await Promise.all([
    sb
      .from("client_business_context")
      .select(
        "business_overview, ideal_customer, main_offer, competitors, brand_voice, proof_testimonials, current_marketing, sales_process, current_revenue, target_revenue",
      )
      .eq("client_id", job.client_id)
      .maybeSingle(),
    loadUpstreamRecords(sb, job.client_id, ["offer_strategy", "icp", "brand_strategy", "money_model"]),
  ]);

  const offer = records.filter((r) => r.domain === "offer_strategy");
  if (offer.length === 0) {
    return {
      ok: false,
      retryable: false,
      failureMessage:
        "No offer strategy exists for this client. An agent that sells cannot be built before there is something to sell — run the Offer Strategist first.",
    };
  }
  const icp = records.filter((r) => r.domain === "icp");
  if (icp.length === 0) {
    return {
      ok: false,
      retryable: false,
      failureMessage:
        "No ICP exists for this client. Qualification questions are written against a specific buyer — run the ICP Agent first.",
    };
  }

  // The page this agent will stand on, if one was chosen. It matters: the
  // agent should not re-argue a case the page already made, and should not
  // contradict its offer.
  let pageBlock = "PAGE — this agent is not yet attached to a page.";
  if (row.page_id) {
    const { data: page } = await sb
      .from("client_pages")
      .select("title, meta_description, body")
      .eq("id", row.page_id)
      .maybeSingle();
    if (page) {
      pageBlock = [
        "PAGE THIS AGENT LIVES ON — the visitor has already read this",
        `Title: ${page.title}`,
        page.meta_description ? `Summary: ${page.meta_description}` : "",
        page.body ? `\n${page.body}` : "",
        "\nDo not re-make the argument the page already made. The visitor talking to you has read it.",
      ]
        .filter(Boolean)
        .join("\n");
    }
  }

  const pkg = await loadPagePackage(sb, job.client_id, clientName);
  const packageBlock = renderPackage(pkg, null);

  const submitTool = {
    name: "submit_sales_agent",
    description: "Submit the finished sales agent definition. Call this exactly once.",
    inputSchema: {
      type: "object",
      properties: {
        greeting: {
          type: "string",
          description: "The first thing the agent says to a visitor. One or two sentences, in the brand voice.",
        },
        system_prompt: {
          type: "string",
          description:
            "The complete operating instructions this agent runs on: who it is, who it is talking to, what it is selling, how it behaves, what it must never do. Written as instructions to the agent itself, in the second person.",
        },
        qualification: {
          type: "array",
          description: `The questions that separate a buyer from a browser, in the order to ask them. At least ${MIN_QUALIFICATION}.`,
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "The question, phrased the way a person would ask it out loud." },
              why: { type: "string", description: "What this question is actually establishing." },
              good_answer: { type: "string", description: "What an answer from a real buyer sounds like." },
              disqualifier: { type: "string", description: "The answer that means this is not a fit, and what to do about it." },
            },
            required: ["question", "why", "good_answer", "disqualifier"],
            additionalProperties: false,
          },
        },
        objections: {
          type: "array",
          description: "Objections this specific ICP actually raises, and how to answer each with only what the offer can back.",
          items: {
            type: "object",
            properties: {
              objection: { type: "string" },
              response: { type: "string" },
            },
            required: ["objection", "response"],
            additionalProperties: false,
          },
        },
        booking_rule: {
          type: "string",
          description: "Exactly when this agent asks for the appointment, and what it must have established first.",
        },
        escalation_rule: {
          type: "string",
          description: "When to stop and hand to a person, stated as conditions rather than as a feeling.",
        },
        guardrails: {
          type: "string",
          description:
            "What this agent may never say, claim or promise. Draw these from the offer strategy's stated limits and from what proof exists.",
        },
      },
      required: [
        "greeting",
        "system_prompt",
        "qualification",
        "objections",
        "booking_rule",
        "escalation_rule",
        "guardrails",
      ],
      additionalProperties: false,
    },
  };

  const system = `You build client-facing sales agents for Attract Acquisition, a marketing agency.

What you produce is not copy. It is the operating definition of a machine that will talk to a real business's real customers, unsupervised, at whatever rate that business sends traffic. Write it as something you would be willing to have repeated ten thousand times without anyone checking.

WHAT MAKES A SALES AGENT WORK
- It qualifies before it sells. A visitor who is not a fit should reach a polite end, not a booking. Booking someone who cannot buy costs the client a consultation slot and costs the visitor their afternoon.
- It asks questions a person would actually ask out loud, one at a time, and listens to the answer. A form with a chat window around it is still a form.
- It handles the objections this specific buyer raises, in the words they raise them in.
- It knows when to stop. Every agent needs conditions under which it hands over to a person.

ABSOLUTE RULES
- Never invent a claim, a statistic, a price, a guarantee, a timeline, a credential or a customer. If it is not in what you were given, the agent does not say it. This is the difference between a marketing mistake and a regulatory one, and it is the client who carries it.
- Only reference proof you were actually given as cleared. Uncleared proof does not exist as far as this agent is concerned.
- Respect everything the offer strategy lists as a limit or a thing that cannot be promised. Those become guardrails, stated explicitly, in your own guardrails field.
- Never claim to be a human being. If asked, the agent says plainly what it is.
- Never leave a bracket, a placeholder or a template variable in anything a visitor will read.
- Match the brand voice you are given. If it says never to say something, never say it.`;

  const prompt = `Build a client-facing sales agent for ${clientName}.

WHAT THIS AGENT IS FOR — the operator's brief
${row.purpose}

BUSINESS CONTEXT
${renderContext(context as BusinessContext | null)}

OFFER STRATEGY — what is being sold, and what may not be promised
${renderUpstream(offer)}

ICP — who this agent is talking to, in their language
${renderUpstream(icp)}

BRAND STRATEGY AND MONEY MODEL
${renderUpstream(records.filter((r) => r.domain === "brand_strategy" || r.domain === "money_model"))}

${pageBlock}

${packageBlock}

Call ${submitTool.name} once when you are done.`;

  await appendEvent(sb, job.id, `Building sales agent "${row.name}".`);

  let result;
  try {
    result = await runAgentLoop({
      apiKey: anthropicKeyForAgent(runtime, agent.agent_key),
      model: runtime.model,
      timeoutMs: runtime.providerTimeoutMs,
      deadlineAt,
      system,
      prompt,
      submitTool,
      enableWebSearch: false,
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

  const usage = {
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: result.usage.costUsd,
  };

  const s = (key: string) => String(result.submitted[key] ?? "").trim();
  const definition: SalesAgentDefinition = {
    greeting: s("greeting"),
    system_prompt: s("system_prompt"),
    qualification: normaliseQualification(result.submitted.qualification),
    objections: normaliseObjections(result.submitted.objections),
    booking_rule: s("booking_rule"),
    escalation_rule: s("escalation_rule"),
    guardrails: s("guardrails"),
  };

  const problem = definitionProblem(definition);
  if (problem) {
    return { ok: false, retryable: true, failureMessage: problem, usage };
  }

  const { error } = await sb
    .from("client_sales_agents")
    .update({
      greeting: definition.greeting,
      system_prompt: definition.system_prompt,
      qualification: definition.qualification,
      objections: definition.objections,
      booking_rule: definition.booking_rule,
      escalation_rule: definition.escalation_rule,
      guardrails: definition.guardrails,
      built_at: new Date().toISOString(),
      job_id: job.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  if (error) throw new Error(`Failed to write sales agent: ${error.message}`);

  await appendEvent(
    sb,
    job.id,
    `Built "${row.name}" — ${definition.qualification.length} qualification questions, ${definition.objections.length} objections handled.\n\n${definitionSummary(definition)}`,
    "info",
    { cost_usd: usage.costUsd },
  );
  return { ok: true, retryable: false, usage };
}
