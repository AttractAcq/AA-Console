// POST /admin/business-context/draft — research the business, fill the form.
//
// The only generator here allowed to search the web, because it is the only
// one with nothing upstream to read. Every other draft route works from what
// AA has already worked out; this IS the thing that work is built from.
//
// Searching is what makes it useful and what makes it dangerous. A model
// researching a real company will find a competitor's testimonial and
// attribute it, or read a revenue figure off a directory listing. The prompt
// spends most of its length on that, and draft.ts enforces what it can.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import { anthropicKeyForAgent } from "../config.js";
import { AuthError, requireAdmin } from "../master/auth.js";
import { readJsonBody } from "../mcp/http.js";
import { logger } from "../logging/logger.js";
import { ProviderError, runAgentLoop } from "../tools/anthropic.js";
import { reviewContextDraft } from "./draft.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTES = 6000;

const SUBMIT_TOOL = {
  name: "submit_business_context",
  description: "Submit the drafted business context. Call this exactly once.",
  inputSchema: {
    type: "object",
    properties: {
      business_overview: {
        type: "string",
        description: "What the business does, for whom, and what makes it what it is. Concrete and specific.",
      },
      ideal_customer: {
        type: "string",
        description: "Who they are actually for: the person, their situation, what has gone wrong or changed that makes them a buyer now.",
      },
      main_offer: {
        type: "string",
        description: "What is actually being sold — the service, what it includes, how it is delivered.",
      },
      competitors: {
        type: "string",
        description:
          "Who else this buyer would consider — NAMED — and how each is positioned differently. Include doing nothing if that is the real alternative. You may say how a competitor appears to be positioned, since that is a reading of their own material; you may not leave them unnamed. 'Various local providers' is not competitor research.",
      },
      brand_voice: {
        type: "string",
        description: "How they sound in their own words, taken from their own published writing. Empty if you have not read enough of it.",
      },
      proof_testimonials: {
        type: "string",
        description: "Proof this business itself published, attributed and quoted. Empty if you found none. NEVER anything you could not attribute to them.",
      },
      current_marketing: {
        type: "string",
        description: "What they are visibly doing now — channels, cadence, what the content is. Empty if you could not see.",
      },
      sales_process: {
        type: "string",
        description: "How somebody becomes a customer, as far as it is visible. Empty if it is not.",
      },
      sources: {
        type: "string",
        description: "Where this came from: the pages you read and what each gave you. For the operator to check.",
      },
    },
    required: [
      "business_overview", "ideal_customer", "main_offer", "competitors",
      "brand_voice", "proof_testimonials", "current_marketing", "sales_process", "sources",
    ],
    additionalProperties: false,
  },
};

const SYSTEM = `You draft the business context record for a client of Attract Acquisition, a marketing agency.

This record is read by every agent that follows: the offer strategist, the ICP agent, the campaign planner, the page writer, the creative concept, the sales agent. Thin context makes cautious output everywhere, and nobody can tell why. So be specific, and write what an agent could act on.

A PERSON WILL CHECK THIS, SO MAKE IT CHECKABLE
- Write what the sources actually say. Say where it came from in the sources field.
- If you did not find something, LEAVE THAT FIELD EMPTY. An empty field gets asked about at the next call. A plausible guess gets quoted back to the client as though they said it.
- Never hedge. "Likely", "presumably", "appears to be" mean you are guessing and saying so politely. A hedged sentence reads as fact once it is saved and an agent quotes it.
- The one exception is how a COMPETITOR is positioned. That is a reading of their own published material, and saying "they appear to lead on price" is an honest account of what their pages support. Name the competitor regardless — the hedge is allowed about positioning, never about who exists.

NEVER INVENT
- A testimonial, a review, a case study, a client name, a result or a statistic. If you cannot attribute it to this business's own published material, it does not go in.
- A competitor's claim attributed to this business. When researching a sector you will read a lot of other companies' pages; keep them straight.
- A revenue figure, a headcount, a founding date or a price you did not read directly. Do not estimate from a sector average.
- Anything about regulated practice — clinical claims, qualifications, registrations — beyond what they themselves state.

WHAT GOOD LOOKS LIKE
- Ideal customer names a situation, not a demographic. "Over-55s" is a filter; "has a bridge that has failed twice and has stopped eating on one side" is a buyer.
- Competitors are named, and the difference is stated. "Various local providers" is not competitor research.
- Brand voice quotes how they actually write, not how you would describe an aspiration.`;

export async function handleContextDraft(
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
    body = await readJsonBody(req, 10_000);
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
    const [{ data: client }, { data: contact }, { data: existing }] = await Promise.all([
      sb.from("clients").select("name, sector, location").eq("id", clientId).maybeSingle(),
      sb
        .from("client_contact_details")
        .select("website, instagram, facebook, address, primary_contact, role_title, notes")
        .eq("client_id", clientId)
        .maybeSingle(),
      sb
        .from("client_business_context")
        .select("business_overview, ideal_customer, main_offer, competitors")
        .eq("client_id", clientId)
        .maybeSingle(),
    ]);

    if (!client) {
      json(200, { ok: false, error: "That client no longer exists." });
      return;
    }

    const c = (contact ?? {}) as Record<string, string | null>;
    const website = c.website ?? null;

    // Without a website and without notes there is nothing to research and
    // nothing to work from. Saying so beats charging for a confident guess.
    if (!website && !notes) {
      json(200, {
        ok: false,
        error:
          "There is no website on file for this client and nothing typed in the box. Add a website under Contact & Identity, or say what you know from the call.",
      });
      return;
    }

    const prompt = `Draft the business context for ${client.name}.

WHAT WE ALREADY KNOW
Name: ${client.name}
${client.sector ? `Sector: ${client.sector}` : ""}
${client.location ? `Location: ${client.location}` : ""}
${website ? `Website: ${website}` : "No website on file."}
${c.instagram ? `Instagram: ${c.instagram}` : ""}
${c.address ? `Address: ${c.address}` : ""}
${c.primary_contact ? `Main contact: ${c.primary_contact}${c.role_title ? `, ${c.role_title}` : ""}` : ""}
${c.notes ? `Notes on file: ${c.notes}` : ""}

${notes ? `WHAT THE OPERATOR KNOWS FROM TALKING TO THEM — trust this over anything you read online\n${notes}\n` : "The operator has not added anything. Work from what you can read.\n"}
${
  existing?.business_overview
    ? `WHAT IS ALREADY RECORDED — improve on it, and do not lose anything true that is already here\n${JSON.stringify(existing, null, 2)}\n`
    : ""
}
${
  website
    ? `Read ${website} and what this business has published elsewhere. Their own words are the best source for voice and for proof.`
    : "There is no website to read. Work only from what the operator told you, and leave everything else empty."
}

Call ${SUBMIT_TOOL.name} once when you are done.`;

    const result = await runAgentLoop({
      apiKey: anthropicKeyForAgent(config, "context_draft"),
      model: config.model,
      timeoutMs: config.providerTimeoutMs,
      // Longer than the other drafters: this one reads pages. Still bounded,
      // because somebody is sitting in front of the form.
      deadlineAt: Date.now() + 300_000,
      maxTurns: 12,
      system: SYSTEM,
      prompt,
      submitTool: SUBMIT_TOOL,
      // The only draft route that searches, and the reason the rules above are
      // stricter than anywhere else.
      enableWebSearch: Boolean(website),
      maxSearches: 10,
    });

    const review = reviewContextDraft(result.submitted);
    if (review.problem) {
      logger.warn("context_draft_rejected", { clientId, problem: review.problem });
      json(200, { ok: false, error: review.problem });
      return;
    }
    if (review.dropped.length > 0) {
      logger.warn("context_draft_fields_dropped", {
        clientId,
        dropped: review.dropped.map((d) => d.field).join(","),
      });
    }

    json(200, {
      ok: true,
      draft: review.draft,
      dropped: review.dropped,
      sources: String(result.submitted.sources ?? ""),
      costUsd: result.usage.costUsd,
    });
  } catch (err) {
    const message =
      err instanceof ProviderError
        ? err.message
        : err instanceof Error
          ? err.message
          : "The generator could not be reached.";
    logger.error("context_draft_failed", { clientId, error: message });
    json(200, { ok: false, error: message });
  }
}
