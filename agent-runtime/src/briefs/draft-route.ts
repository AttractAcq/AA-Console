// POST /admin/briefs/draft — the ask for a sales agent, or for a page.
//
// One route for both, because they are the same job: write the paragraph an
// operator would write before an agent that then reads the strategy for
// itself. What differs is what is being briefed, and that is a prompt.
//
// Neither is the thing itself. This does not write the agent's script or the
// page's copy — those agents are good at that and read far more than this
// does. It writes the ask they start from.

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
import { askProblem, normaliseAsk, type BriefKind } from "./draft.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTES = 4000;

const SALES_ROLE: Record<string, string> = {
  inbound_qualifier: "an inbound qualifier — it meets somebody who has just arrived and works out whether there is anything here for them",
  appointment_setter: "an appointment setter — its whole job is getting a specific time in a diary",
  nurture: "a nurture agent — it keeps a conversation alive with somebody who is not ready yet",
  reactivation: "a reactivation agent — it restarts a conversation with somebody who went quiet",
  closer_assist: "a closer assist — it supports a human closer rather than replacing them",
};

const PAGE_KIND: Record<string, string> = {
  landing: "a primary landing page — the main page traffic is sent to, carrying the core offer",
  offer: "a secondary offer page — a focused page for one specific offer, reached from elsewhere",
  recruitment: "a hiring page — where a recruitment ad sends somebody deciding whether to apply for a job",
};

const SUBMIT_TOOL = {
  name: "submit_ask",
  description: "Submit the brief. Call this exactly once.",
  inputSchema: {
    type: "object",
    properties: {
      ask: {
        type: "string",
        description:
          "What this is for, as the operator would write it. A short paragraph: the job it is doing, the moment it does it in, and what it must not do. Not the script and not the copy.",
      },
      reasoning: {
        type: "string",
        description: "Why this shape and not another, from what is on file. For the operator, not the agent.",
      },
    },
    required: ["ask", "reasoning"],
    additionalProperties: false,
  },
};

function system(kind: BriefKind): string {
  const subject = kind === "sales_agent" ? "sales agent" : "conversion page";
  return `You write the brief that a ${subject} gets built from, for a client of Attract Acquisition.

You are not writing the ${kind === "sales_agent" ? "agent's script" : "page"}. An agent does that, and it reads the offer strategy, the ICP, the brand voice and the cleared proof for itself. Your paragraph is what it starts from.

SO DO NOT RESTATE THE STRATEGY
The builder already has it. "Leveraging our unique value proposition to engage our ideal customer" is length without information, and it is the failure mode here. Write what the records do NOT contain: which moment this one works in, what it is doing that the others are not, and where it must stop.

WHAT A GOOD ASK CONTAINS
- The job, in one sentence, as an outcome rather than an activity.
- The moment: who it is talking to and what just happened to them.
- The limit: what it must never say or do. ${kind === "sales_agent" ? "A sales agent that will discuss price when the business prices after an assessment is worse than no agent." : "A page that promises what the offer strategy forbids is worse than no page."}
${kind === "sales_agent" ? "- What counts as success for this one. An appointment setter that leaves with an email address has failed." : "- The one action the page asks for. A page with three is a page with none."}

ABSOLUTE RULES
- Never invent a price, a rate, a guarantee, a timeframe or a result. If the records do not state it, the brief does not mention it — a number here becomes a promise in the output.
- Respect anything the offer strategy lists as a limit or a thing that cannot be promised.
- Take the audience from the ICP. Do not invent a new one.`;
}

export async function handleBriefDraft(
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
  const kind = String(body.kind ?? "") as BriefKind;
  if (kind !== "sales_agent" && kind !== "page") {
    json(400, { ok: false, error: "Unknown thing to brief." });
    return;
  }
  const variant = String(body.variant ?? "");
  const notes = String(body.notes ?? "").trim().slice(0, MAX_NOTES);

  try {
    const [{ data: client }, { data: context }, records] = await Promise.all([
      sb.from("clients").select("name").eq("id", clientId).maybeSingle(),
      sb
        .from("client_business_context")
        .select(
          "business_overview, ideal_customer, main_offer, competitors, brand_voice, proof_testimonials, current_marketing, sales_process",
        )
        .eq("client_id", clientId)
        .maybeSingle(),
      loadUpstreamRecords(sb, clientId, ["offer_strategy", "icp", "brand_strategy", "proof"]),
    ]);

    if (!client) {
      json(200, { ok: false, error: "That client no longer exists." });
      return;
    }
    if (records.length === 0 && !context) {
      json(200, {
        ok: false,
        error:
          "There is nothing on file for this client yet — no business context and no strategy work. Fill in Business Input first, or write the brief yourself.",
      });
      return;
    }

    // What already exists, so the brief says what this one does differently
    // rather than describing the one that is already running.
    const { data: siblings } =
      kind === "sales_agent"
        ? await sb
            .from("client_sales_agents")
            .select("name, role, purpose")
            .eq("client_id", clientId)
            .limit(15)
        : await sb
            .from("client_pages")
            .select("title, page_type, brief")
            .eq("client_id", clientId)
            .limit(15);

    const describe =
      kind === "sales_agent"
        ? SALES_ROLE[variant] ?? "a sales agent"
        : PAGE_KIND[variant] ?? PAGE_KIND.landing;

    const prompt = `Write the brief for ${describe}, for ${client.name}.

${notes ? `WHAT THE OPERATOR WANTS FROM THIS ONE — steer by this\n${notes}\n` : "The operator has not steered this. Propose what the records say this one should do.\n"}
BUSINESS CONTEXT
${renderContext(context as BusinessContext | null)}

OFFER STRATEGY, ICP, BRAND AND PROOF — what the builder will already read, so do not repeat it
${renderUpstream(records)}

WHAT ALREADY EXISTS FOR THIS CLIENT — say what this one does that these do not
${
  (siblings ?? []).length > 0
    ? (siblings ?? [])
        .map((row) => {
          const r = row as Record<string, unknown>;
          return `- ${String(r.name ?? r.title ?? "untitled")} (${String(r.role ?? r.page_type ?? "")}): ${String(r.purpose ?? r.brief ?? "no brief")}`;
        })
        .join("\n")
    : "Nothing yet — this is the first."
}

Call ${SUBMIT_TOOL.name} once when you are done.`;

    const result = await runAgentLoop({
      apiKey: anthropicKeyForAgent(config, "brief_draft"),
      model: config.model,
      timeoutMs: config.providerTimeoutMs,
      deadlineAt: Date.now() + 120_000,
      maxTurns: 4,
      system: system(kind),
      prompt,
      submitTool: SUBMIT_TOOL,
      enableWebSearch: false,
    });

    const problem = askProblem(result.submitted, kind);
    if (problem) {
      logger.warn("brief_draft_rejected", { clientId, kind, problem });
      json(200, { ok: false, error: problem });
      return;
    }

    json(200, { ok: true, draft: normaliseAsk(result.submitted), costUsd: result.usage.costUsd });
  } catch (err) {
    const message =
      err instanceof ProviderError
        ? err.message
        : err instanceof Error
          ? err.message
          : "The generator could not be reached.";
    logger.error("brief_draft_failed", { clientId, kind, error: message });
    json(200, { ok: false, error: message });
  }
}
