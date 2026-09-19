// POST /admin/campaigns/draft — propose a campaign worth running.
//
// Admin-authenticated and synchronous, for the same reason as the recruitment
// draft: it fills a form somebody is sitting in front of, and a form that
// populates itself four minutes later is one they have already typed into.
//
// It reads more of the client's records than any single agent does. The
// planner reads the offer and the ICP because it is planning a campaign it has
// already been told to plan; this is deciding WHICH campaign, and that needs
// the competitor and market work, the money model and the proof on file too.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import { anthropicKeyForAgent } from "../config.js";
import { AuthError, requireAdmin } from "../master/auth.js";
import { readJsonBody } from "../mcp/http.js";
import { logger } from "../logging/logger.js";
import { ProviderError, runAgentLoop } from "../tools/anthropic.js";
import { loadUpstreamRecords, renderContext, renderUpstream } from "../agents/shared.js";
import type { BusinessContext } from "../agents/shared.js";
import { campaignDraftProblem, normaliseCampaignDraft } from "./draft.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTES = 4000;

const SUBMIT_TOOL = {
  name: "submit_campaign_proposal",
  description: "Submit the proposed campaign. Call this exactly once.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "A short internal name for this campaign — what somebody would call it in a standup. Not a headline.",
      },
      brief: {
        type: "string",
        description:
          "What this campaign is for, as the operator would write it: the outcome it is chasing, who it is aimed at, and why now. A short paragraph. The planner turns this into objective, audience, message, channels and what has to be built, so give it something to work from rather than the plan itself.",
      },
      reasoning: {
        type: "string",
        description: "Why this campaign and not another, from what is on file. For the operator, not the planner.",
      },
    },
    required: ["name", "brief", "reasoning"],
    additionalProperties: false,
  },
};

const SYSTEM = `You propose marketing campaigns for clients of Attract Acquisition, a marketing agency.

You are not planning the campaign. A planner does that, and it is good at it. You are answering the question before it: given everything this business has told us and everything we have worked out about it, what campaign is actually worth running next?

WHAT MAKES A PROPOSAL GOOD
- It comes from something specific on file — a gap in the offer, a competitor's position, a segment of the ICP nobody is talking to, a money-model constraint. Name that thing in the ask.
- It chases one outcome. "Build awareness" is not an outcome; "fill the January consult diary" is.
- It is something this business can actually do with what it has. A campaign needing a film crew it does not have is not a proposal, it is a wish.
- It is specific enough that the planner can disagree with it usefully.

ABSOLUTE RULES
- Never invent a budget, a price, a date, a target, a headcount or a result. If the records do not say it, the ask does not mention it. A figure written here becomes a commitment the plan is built on.
- Never invent proof — no statistic, testimonial, case study or credential that is not on file.
- Take the audience from the ICP and the offer from the offer strategy. Do not invent either.
- Respect anything the offer strategy lists as a limit or a thing that cannot be promised.`;

export async function handleCampaignDraft(
  req: IncomingMessage,
  res: ServerResponse,
  sb: SupabaseClient,
  config: RuntimeConfig,
): Promise<void> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  try {
    await requireAdmin(sb, req.headers.authorization);
  } catch (err) {
    json(err instanceof AuthError ? err.status : 401, { ok: false, error: "Not permitted." });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req, 8192);
  } catch {
    json(400, { ok: false, error: "That request could not be read." });
    return;
  }

  const clientId = String(body.clientId ?? "");
  if (!UUID.test(clientId)) {
    json(400, { ok: false, error: "A client is required." });
    return;
  }
  // Optional, unlike a hiring brief: the business's own strategy is already on
  // file, so a blank box should still produce a real proposal.
  const notes = String(body.notes ?? "").trim().slice(0, MAX_NOTES);

  try {
    const { data: client } = await sb.from("clients").select("name").eq("id", clientId).maybeSingle();
    const clientName = (client?.name as string | undefined) ?? "this business";

    const [{ data: context }, records] = await Promise.all([
      sb
        .from("client_business_context")
        .select(
          "business_overview, ideal_customer, main_offer, competitors, brand_voice, proof_testimonials, current_marketing, sales_process, current_revenue, target_revenue",
        )
        .eq("client_id", clientId)
        .maybeSingle(),
      // Wider than any single agent reads, because choosing a campaign is a
      // judgement across all of it rather than execution within one part.
      loadUpstreamRecords(sb, clientId, [
        "offer_strategy",
        "icp",
        "brand_strategy",
        "money_model",
        "market",
        "competitor",
        "campaign_intel",
        "proof",
      ]),
    ]);

    if (records.length === 0 && !context) {
      json(200, {
        ok: false,
        error:
          "There is nothing on file for this client yet — no business context and no strategy work. Run the intelligence agents first, or write the campaign yourself.",
      });
      return;
    }

    const { data: existing } = await sb
      .from("client_campaigns")
      .select("name, brief, status")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(20);

    const prompt = `Propose the next campaign worth running for ${clientName}.

${notes ? `WHAT THE OPERATOR WANTS FROM THIS ONE — steer by this\n${notes}\n` : "The operator has not steered this. Propose what the records say is most worth doing.\n"}
BUSINESS CONTEXT
${renderContext(context as BusinessContext | null)}

EVERYTHING WORKED OUT ABOUT THIS BUSINESS — offer, ICP, brand, money model, market, competitors, campaign intelligence and proof
${renderUpstream(records)}

CAMPAIGNS THAT ALREADY EXIST — do not propose one of these again
${
  (existing ?? []).length > 0
    ? (existing ?? []).map((c) => `- ${c.name} (${c.status}): ${c.brief ?? "no brief"}`).join("\n")
    : "None yet."
}

Call ${SUBMIT_TOOL.name} once when you are done.`;

    const result = await runAgentLoop({
      apiKey: anthropicKeyForAgent(config, "campaign_draft"),
      model: config.model,
      timeoutMs: config.providerTimeoutMs,
      deadlineAt: Date.now() + 120_000,
      maxTurns: 4,
      system: SYSTEM,
      prompt,
      submitTool: SUBMIT_TOOL,
      enableWebSearch: false,
    });

    const problem = campaignDraftProblem(result.submitted);
    if (problem) {
      logger.warn("campaign_draft_rejected", { clientId, problem });
      json(200, { ok: false, error: problem });
      return;
    }

    json(200, {
      ok: true,
      draft: normaliseCampaignDraft(result.submitted),
      costUsd: result.usage.costUsd,
    });
  } catch (err) {
    const message =
      err instanceof ProviderError
        ? err.message
        : err instanceof Error
          ? err.message
          : "The generator could not be reached.";
    logger.error("campaign_draft_failed", { clientId, error: message });
    json(200, { ok: false, error: message });
  }
}
