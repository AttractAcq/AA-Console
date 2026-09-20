// POST /admin/pillars/draft — propose this brand's content pillars.
//
// Admin-authenticated and synchronous, like the other draft routes: it fills
// a screen somebody is sitting in front of.
//
// The interesting input is not the brand strategy. It is the territories the
// ideation agent has ALREADY been writing. Asked on every run to name "which
// content territory from the brand strategy this sits in", it has been
// inventing a set each time and converging on roughly the same one —
// "Continuity and certainty" one run, "Continuity and Certainty" the next.
// Those near-duplicates are the evidence that the pillars are already there
// and only lacked somewhere to live, so they are handed to the model as the
// draft to consolidate rather than left for it to rediscover.

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
import { MAX_PILLARS, MIN_PILLARS, normalisePillars, pillarSetProblem } from "./draft.js";
import { pillarContextPack } from "./pack.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTES = 4000;

const SUBMIT_TOOL = {
  name: "submit_content_pillars",
  description: "Submit the proposed content pillars. Call this exactly once.",
  inputSchema: {
    type: "object",
    properties: {
      pillars: {
        type: "array",
        description: `Between ${MIN_PILLARS} and ${MAX_PILLARS} pillars.`,
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "What this pillar is called. Short, specific to this business, and memorable enough that somebody would say it out loud. Not a category label like 'Educational'.",
            },
            premise: {
              type: "string",
              description:
                "What this pillar argues, in one line. A position the business holds, not a topic it covers.",
            },
            belongs: {
              type: "string",
              description: "What goes in this pillar. Be concrete about the kinds of thing that qualify.",
            },
            does_not_belong: {
              type: "string",
              description:
                "What stays OUT of this pillar, including anything that looks like it belongs but does not. This boundary is what stops a pillar absorbing everything, so it must be real rather than a restatement of the inclusion.",
            },
            target_share: {
              type: "number",
              description:
                "Roughly what percentage of the calendar this pillar should carry. Shares across all pillars must total 100.",
            },
          },
          required: ["name", "premise", "belongs", "does_not_belong", "target_share"],
          additionalProperties: false,
        },
      },
      reasoning: {
        type: "string",
        description:
          "Why this set and not another, and where you consolidated territories that were the same pillar under different names. For the strategist, not for storage.",
      },
    },
    required: ["pillars", "reasoning"],
    additionalProperties: false,
  },
} as const;

const SYSTEM = `You define content pillars for clients of Attract Acquisition, a marketing agency.

A content pillar is one of the three to six things a brand posts about, consistently, for months. It is a position the business holds, not a topic it covers: "Honest proof" is a pillar, "Case studies" is a format.

WHAT MAKES THIS SET GOOD
- ${MIN_PILLARS} to ${MAX_PILLARS} pillars. Fewer is not a strategy. More is a list of labels, and a set that grows past six always collapses back into repetition with extra names.
- Each one specific to THIS business. A pillar that would suit any company in the sector is a category cliché — delete it and find the one only this business can hold.
- Together they should cover what this buyer actually needs to hear across a whole sales cycle, not four angles on the same point.

THE BOUNDARY MATTERS MOST
Every pillar says what does NOT belong in it. This is the half that gets skipped and the half that does the work: a pillar defined only by what belongs will absorb anything, and an agent sorting ideas into pillars needs the edge to sort against. "Not X" where X is obviously outside the business is not a boundary. Name the thing that looks like it belongs and does not.

ABSOLUTE RULES
- Never invent proof, results, figures or customers.
- Shares must total 100.
- If you are given territories already in use, treat them as a first draft to consolidate. Near-duplicates under different wording are one pillar, not two — say which you merged.`;

export async function handlePillarDraft(
  req: IncomingMessage,
  res: ServerResponse,
  sb: SupabaseClient,
  config: RuntimeConfig,
): Promise<void> {
  const json = (status: number, payload: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  try {
    await requireAdmin(sb, req.headers.authorization);
  } catch (err) {
    json(err instanceof AuthError ? err.status : 500, {
      ok: false,
      error: err instanceof Error ? err.message : "Not permitted.",
    });
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
  const notes = String(body.notes ?? "").trim().slice(0, MAX_NOTES);

  try {
    const { data: client } = await sb.from("clients").select("name").eq("id", clientId).maybeSingle();
    const clientName = (client?.name as string | undefined) ?? "this business";

    const [{ data: context }, records, { data: territories }] = await Promise.all([
      sb
        .from("client_business_context")
        .select("business_overview, ideal_customer, main_offer, competitors, brand_voice")
        .eq("client_id", clientId)
        .maybeSingle(),
      loadUpstreamRecords(sb, clientId, ["brand_strategy", "icp", "offer_strategy"]),
      // Campaign-generated ideas carry the campaign name here rather than a
      // territory, so they are excluded: they would propose a pillar per
      // campaign, which is the opposite of what a pillar is.
      sb
        .from("client_ideas")
        .select("content_territory")
        .eq("client_id", clientId)
        .not("content_territory", "is", null)
        .not("content_territory", "like", "Campaign:%")
        .limit(500),
    ]);

    if (records.length === 0 && !context) {
      json(200, {
        ok: false,
        error:
          "There is nothing on file for this client yet — no business context and no strategy work. Run the intelligence agents first.",
      });
      return;
    }

    const counts = new Map<string, number>();
    for (const row of territories ?? []) {
      const t = String((row as { content_territory?: unknown }).content_territory ?? "").trim();
      if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const inUse = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `- ${t} (${n} idea${n === 1 ? "" : "s"})`)
      .join("\n");

    const prompt = `Define the content pillars for ${clientName}.

${notes ? `WHAT THE STRATEGIST WANTS FROM THIS SET — steer by this\n${notes}\n` : ""}
BUSINESS CONTEXT
${renderContext(context as BusinessContext | null)}

BRAND STRATEGY, AND THE PARTS OF THE ICP AND OFFER THAT BEAR ON WHAT TO SAY
${renderUpstream(pillarContextPack(records))}

${
  inUse
    ? `TERRITORIES ALREADY IN USE — the ideation agent invented these across separate runs, with no memory between them. Several are the same pillar named twice. Consolidate them into a real set rather than starting over; the idea counts show which have carried weight.\n${inUse}`
    : "TERRITORIES ALREADY IN USE\nNone. This client has no ideas on file yet, so define the set from the strategy."
}

Call ${SUBMIT_TOOL.name} once when you are done.`;

    const result = await runAgentLoop({
      apiKey: anthropicKeyForAgent(config, "pillar_draft"),
      model: config.model,
      timeoutMs: config.providerTimeoutMs,
      // 300s, matching the context route rather than the campaign proposer.
      // Copying the proposer's 120s was wrong: this reads a brand's whole
      // strategy and returns six pillars of five fields each, which is a
      // different shape of work from writing one short brief.
      deadlineAt: Date.now() + 300_000,
      maxTurns: 4,
      system: SYSTEM,
      prompt,
      submitTool: SUBMIT_TOOL,
      enableWebSearch: false,
    });

    const pillars = normalisePillars(result.submitted.pillars);
    const problem = pillarSetProblem(pillars);
    if (problem) {
      logger.warn("pillar_draft_rejected", { clientId, problem, proposed: pillars.length });
      json(200, { ok: false, error: problem });
      return;
    }

    json(200, {
      ok: true,
      draft: { pillars },
      reasoning: String(result.submitted.reasoning ?? "").trim(),
      costUsd: result.usage.costUsd,
    });
  } catch (err) {
    const message =
      err instanceof ProviderError ? err.message : err instanceof Error ? err.message : "That did not work.";
    logger.error("pillar_draft_failed", { clientId, error: message });
    json(200, { ok: false, error: message });
  }
}
