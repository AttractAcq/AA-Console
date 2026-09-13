// Campaign Planner.
//
// The orchestrator's first half: turn a one-line ask into a plan that says
// what has to exist before anything can run. The second half is SQL —
// provision_campaign creates the rows in tools 2 and 3, campaign_readiness
// checks them, launch_campaign refuses until they are real.
//
// The plan's job is therefore not prose. It is the set of numbers the
// readiness check measures against, which is why a plan that asks for nothing
// is rejected rather than stored.

import type { SupabaseClient } from "@supabase/supabase-js";
import { anthropicKeyForAgent, type RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { ProviderError, runAgentLoop } from "../../tools/anthropic.js";
import { loadUpstreamRecords, renderContext, renderUpstream } from "../shared.js";
import type { BusinessContext } from "../shared.js";
import {
  campaignIdeas,
  asAmount,
  asCount,
  asDate,
  normaliseChannels,
  planProblem,
  planSummary,
  MAX_CONTENT,
  type CampaignPlan,
} from "./plan.js";

export async function runCampaignPlanJob(
  sb: SupabaseClient,
  runtime: RuntimeConfig,
  agent: AgentRow,
  job: AgentJobRow,
  deadlineAt: number,
): Promise<JobResult> {
  if (!job.client_id) {
    return { ok: false, retryable: false, failureMessage: "Campaign planning requires a client." };
  }
  if (job.input_table !== "client_campaigns" || !job.input_id) {
    return {
      ok: false,
      retryable: false,
      failureMessage: "This agent plans a campaign created by New Campaign — it has nothing to plan.",
    };
  }

  const { data: campaign, error: campaignError } = await sb
    .from("client_campaigns")
    .select("*")
    .eq("id", job.input_id)
    .eq("client_id", job.client_id)
    .maybeSingle();
  if (campaignError) throw new Error(`Failed to load campaign: ${campaignError.message}`);
  if (!campaign) {
    return { ok: false, retryable: false, failureMessage: "That campaign no longer exists." };
  }
  // A committed batch survives worker crashes and repeated generation requests.
  if (campaign.content_ideas_generated_at) return { ok: true, retryable: false };

  if (!campaign.brief || campaign.brief.trim().length === 0) {
    return {
      ok: false,
      retryable: false,
      failureMessage: "The campaign has no brief. Say what it is for and try again.",
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
      failureMessage: "No offer strategy exists for this client. Run the Offer Strategist first.",
    };
  }
  const icp = records.filter((r) => r.domain === "icp");
  if (icp.length === 0) {
    return {
      ok: false,
      retryable: false,
      failureMessage: "No ICP exists for this client. Run the ICP Agent first.",
    };
  }

  const submitTool = {
    name: "submit_campaign_plan",
    description: "Submit the finished campaign plan. Call this exactly once.",
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string", description: "What this campaign is for, in one sentence, stated as an outcome rather than an activity." },
        audience: { type: "string", description: "Who it is aimed at, taken from the ICP rather than invented." },
        offer_summary: { type: "string", description: "What is being offered, drawn from the offer strategy." },
        core_message: { type: "string", description: "The one idea every piece of this campaign carries." },
        channels: {
          type: "array",
          items: { type: "string" },
          description: "Where it runs. Only channels this business can actually operate.",
        },
        budget: { type: "number", description: "Total budget in the client's currency, or omit if unknown. Do not invent one." },
        starts_on: { type: "string", description: "YYYY-MM-DD, or omit." },
        ends_on: { type: "string", description: "YYYY-MM-DD, or omit." },
        kpi_metric: { type: "string", description: "The single number this campaign is scored on." },
        kpi_target: { type: "number", description: "The target for that number, or omit if there is no basis for one." },
        content_count: {
          type: "number",
          description: `How many distinct pieces of content this campaign needs. 0 if none. At most ${MAX_CONTENT}.`,
        },
        ideas: {
          type: "array",
          description: "Exactly content_count distinct campaign-specific ideas, one per planned piece. These become the production queue, not finished briefs.",
          maxItems: MAX_CONTENT,
          items: {
            type: "object",
            properties: {
              title: { type: "string", maxLength: 300 },
              body: { type: "string", description: "The concrete angle, buyer question, intended response and call to action for this piece. Respect campaign constraints." },
              media_type: { type: "string", enum: ["image", "text", "video"] },
              channel: { type: "string", description: "Which of the campaign's channels this piece is for." },
              strategic_reason: { type: "string", description: "Why this distinct piece helps achieve the campaign objective." },
            },
            required: ["title", "body", "media_type", "channel", "strategic_reason"],
            additionalProperties: false,
          },
        },
        needs_landing_page: { type: "boolean", description: "Whether this campaign needs its own landing page built." },
        needs_sales_agent: { type: "boolean", description: "Whether it needs a client-facing sales agent on that page." },
        reasoning: { type: "string", description: "Why this shape, and what you deliberately left out." },
      },
      required: [
        "objective", "audience", "offer_summary", "core_message", "channels",
        "kpi_metric", "content_count", "ideas", "needs_landing_page", "needs_sales_agent", "reasoning",
      ],
      additionalProperties: false,
    },
  };

  const system = `You plan marketing campaigns for Attract Acquisition, a marketing agency.

A plan here is not a document. It is an instruction to build things: whatever you ask for will be created as real work — pages written, agents built, content briefed — and the campaign cannot launch until each piece actually exists. So ask for what the campaign genuinely needs and nothing else.

WHAT MAKES A PLAN GOOD
- One objective, stated as an outcome. "Raise awareness" is not an outcome; "book 40 consultations in January" is.
- One core message the whole campaign carries. A campaign saying three things says none of them.
- Channels this business can actually operate, not the full list.
- A single KPI. A campaign scored on five numbers cannot be stopped, because there is always one going up.

ABSOLUTE RULES
- Never invent a budget, a price, a date or a target you have no basis for. Omitting a number is honest; inventing one becomes a commitment somebody else has to meet.
- Take the audience from the ICP and the offer from the offer strategy. Do not invent either.
- Supply exactly content_count distinct ideas tailored to this campaign, its audience, offer, dates, channels and constraints. An idea is an angle and purpose, not a finished production brief.
- Ask only for what is needed. Every piece of content you request is real work for a real person.
- Respect anything the offer strategy lists as a limit or a thing that cannot be promised.`;

  const prompt = `Plan a campaign for ${clientName}.

WHAT THIS CAMPAIGN IS FOR — the operator's brief
${campaign.brief}

${campaign.built_at ? `EXISTING APPROVED CAMPAIGN PLAN — preserve these decisions. Generate exactly ${campaign.content_count} ideas for it; do not replan it.
${JSON.stringify({ objective: campaign.objective, audience: campaign.audience, offer_summary: campaign.offer_summary, core_message: campaign.core_message, channels: campaign.channels, starts_on: campaign.starts_on, ends_on: campaign.ends_on, kpi_metric: campaign.kpi_metric, content_count: campaign.content_count })}` : ""}

BUSINESS CONTEXT
${renderContext(context as BusinessContext | null)}

OFFER STRATEGY — what is being sold and what may not be promised
${renderUpstream(offer)}

ICP — who this is aimed at
${renderUpstream(icp)}

BRAND STRATEGY AND MONEY MODEL
${renderUpstream(records.filter((r) => r.domain === "brand_strategy" || r.domain === "money_model"))}

Call ${submitTool.name} once when you are done.`;

  await appendEvent(sb, job.id, `Planning campaign "${campaign.name}".`);

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
  const submittedPlan: CampaignPlan = {
    objective: s("objective"),
    audience: s("audience"),
    offer_summary: s("offer_summary"),
    core_message: s("core_message"),
    channels: normaliseChannels(result.submitted.channels),
    budget: asAmount(result.submitted.budget),
    starts_on: asDate(result.submitted.starts_on),
    ends_on: asDate(result.submitted.ends_on),
    kpi_metric: s("kpi_metric"),
    kpi_target: asAmount(result.submitted.kpi_target),
    content_count: asCount(result.submitted.content_count),
    needs_landing_page: result.submitted.needs_landing_page === true,
    needs_sales_agent: result.submitted.needs_sales_agent === true,
  };

  const plan: CampaignPlan = campaign.built_at ? {
    objective: campaign.objective, audience: campaign.audience, offer_summary: campaign.offer_summary,
    core_message: campaign.core_message, channels: campaign.channels, budget: campaign.budget,
    starts_on: campaign.starts_on, ends_on: campaign.ends_on, kpi_metric: campaign.kpi_metric,
    kpi_target: campaign.kpi_target, content_count: campaign.content_count,
    needs_landing_page: campaign.needs_landing_page, needs_sales_agent: campaign.needs_sales_agent,
  } : submittedPlan;
  const problem = planProblem(plan);
  if (problem) {
    return { ok: false, retryable: true, failureMessage: problem, usage };
  }

  let ideas;
  try {
    ideas = campaignIdeas(result.submitted.ideas, plan.content_count);
  } catch (error) {
    return { ok: false, retryable: true, failureMessage: (error as Error).message, usage };
  }
  // One transaction commits the plan and its exact idea batch, or neither.
  // The database locks the campaign so concurrent jobs cannot duplicate it.
  const { error } = await sb.rpc("save_campaign_plan_with_ideas", {
    p_campaign_id: campaign.id,
    p_client_id: job.client_id,
    p_job_id: job.id,
    p_plan: plan,
    p_ideas: ideas,
  });
  if (error) throw new Error(`Failed to write campaign plan and ideas: ${error.message}`);

  await appendEvent(sb, job.id, `Planned "${campaign.name}".\n\n${planSummary(plan)}`, "info", {
    cost_usd: usage.costUsd,
  });
  return { ok: true, retryable: false, usage };
}
