// POST /admin/recruitment/draft — write a hiring ad for this specific opening.
//
// Admin-authenticated, like the other /admin routes: it spends money on a model
// call and the output goes into an ad AA will run under its own name.
//
// Synchronous rather than queued, which is the opposite of how agents normally
// run here. A queued job is right when the work takes minutes and the answer
// lands on a page somebody comes back to. This fills a form the operator is
// sitting in front of, and a form that populates itself four minutes after you
// asked is a form you have already typed into.

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
import { draftProblem, normaliseDraft } from "./draft.js";

const ROLES = ["editor", "smm", "avatar"] as const;
const ROLE_LABEL: Record<string, string> = {
  editor: "Editor",
  smm: "Social Media Manager",
  avatar: "Avatar",
};

const MAX_NOTES = 4000;

const SUBMIT_TOOL = {
  name: "submit_recruitment_brief",
  description: "Submit the finished hiring brief. Call this exactly once.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "A short internal label for this brief — the role and the one thing that makes this opening specific. A dozen words, not a restatement of the notes.",
      },
      hook: {
        type: "string",
        description: "The headline — the largest words on the ad. Meta truncates around 40 characters, so aim for under 40 and never exceed 80. Short is the whole job here.",
      },
      script: {
        type: "string",
        description:
          "The primary text of the ad. What the role actually involves, who it suits, and what is true about working here. Meta shows roughly the first 125 characters before 'See more', so lead with the sharpest thing. Aim for 400-600 characters and never exceed 900.",
      },
      call_to_action: {
        type: "string",
        description: "The action asked for. Two or three words, under 30 characters.",
      },
      visual_direction: {
        type: "string",
        description:
          "What the still should show: subject, setting, light, treatment. Specific enough to brief an image from, and never a stock cliche. Two to four sentences — an image model needs a clear picture, not an exhaustive one.",
      },
      premise: {
        type: "string",
        description: "The internal framing in one or two sentences: what kind of person this ad is trying to attract, and who it is meant to put off.",
      },
    },
    required: ["title", "hook", "script", "call_to_action", "visual_direction", "premise"],
    additionalProperties: false,
  },
};

const SYSTEM = `You write hiring ads for Attract Acquisition, a marketing agency, to run as Meta static placements.

This is recruitment, not a client campaign. The reader is a person deciding whether to apply for a job, not a business deciding whether to buy.

WHAT MAKES ONE GOOD
- Say what the work actually is. "Join our dynamic team" tells nobody anything; "you take an approved brief and cut it into a still that looks like the practice" does.
- Be honest about the shape of it — the hours, the pace, the kind of client — because an ad that oversells produces applicants who leave.
- Write for the person who would be good at it, and be willing to put off the person who would not.
- One idea. An ad arguing three things argues none of them.

ABSOLUTE RULES
- Never invent a rate, a salary, a benefit, a location, a start date or a team size. If the operator did not tell you, do not state it.
- Never write a URL, an email address or a phone number. Candidates leave through an Apply link a person fills in separately.
- Never write a bracketed placeholder. If you do not have the words, leave the element out.
- Take the voice from the brand strategy. If it says never to say something, never say it.

LENGTH IS PART OF THE CRAFT
This runs as a Meta static. The headline is truncated around 40 characters and the primary text around 125 before a reader has to tap. Writing to the maximum is not thoroughness, it is a draft nobody finished — cut it until every line is load-bearing.`;

export async function handleRecruitmentDraft(
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

  const role = String(body.role ?? "");
  if (!(ROLES as readonly string[]).includes(role)) {
    json(400, { ok: false, error: "Choose a role of editor, smm or avatar." });
    return;
  }
  const notes = String(body.notes ?? "").trim().slice(0, MAX_NOTES);
  if (!notes) {
    json(400, { ok: false, error: "Say something about this role — the generator has nothing to work from otherwise." });
    return;
  }

  try {
    const { data: houseId, error: houseError } = await sb.rpc("aa_house_client_id");
    if (houseError || !houseId) throw new Error("The Attract Acquisition house client is missing.");

    // The same sources the client-facing agents read, pointed at AA itself.
    // This is the whole reason the output beats a stub: it knows who is hiring.
    const [{ data: context }, records] = await Promise.all([
      sb
        .from("client_business_context")
        .select(
          "business_overview, ideal_customer, main_offer, competitors, brand_voice, proof_testimonials, current_marketing, sales_process, current_revenue, target_revenue",
        )
        .eq("client_id", houseId)
        .maybeSingle(),
      loadUpstreamRecords(sb, houseId as string, ["brand_strategy", "offer_strategy", "icp", "proof"]),
    ]);

    const prompt = `Write a Meta static hiring ad for Attract Acquisition.

ROLE
${ROLE_LABEL[role] ?? role}

WHAT THE OPERATOR SAYS ABOUT THIS PARTICULAR OPENING — the most important input, and the reason this is not a template
${notes}

WHAT ATTRACT ACQUISITION IS
${renderContext(context as BusinessContext | null)}

BRAND STRATEGY, OFFER AND PROOF — for voice and for what is true
${renderUpstream(records)}

Call ${SUBMIT_TOOL.name} once when you are done.`;

    const result = await runAgentLoop({
      apiKey: anthropicKeyForAgent(config, "recruitment_draft"),
      model: config.model,
      timeoutMs: config.providerTimeoutMs,
      // A person is waiting on a form, so this gets one pass rather than the
      // long budget a queued agent gets.
      deadlineAt: Date.now() + 120_000,
      maxTurns: 4,
      system: SYSTEM,
      prompt,
      submitTool: SUBMIT_TOOL,
      enableWebSearch: false,
    });

    const problem = draftProblem(result.submitted);
    if (problem) {
      logger.warn("recruitment_draft_rejected", { role, problem });
      json(200, { ok: false, error: problem });
      return;
    }

    json(200, {
      ok: true,
      draft: normaliseDraft(result.submitted),
      costUsd: result.usage.costUsd,
    });
  } catch (err) {
    const message =
      err instanceof ProviderError
        ? err.message
        : err instanceof Error
          ? err.message
          : "The generator could not be reached.";
    logger.error("recruitment_draft_failed", { role, error: message });
    json(200, { ok: false, error: message });
  }
}
