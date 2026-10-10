// Ideation — the agent v5 never got working (15 cycles, 13 terminal
// failures, 0 completions). Built to docs/AA_V5_IDEATION_ARCHITECTURE.md.
//
// Two architectural rules from that document drive this implementation,
// and both are things a naive build gets wrong:
//
//   1. "Ideation must never receive the whole intelligence corpus."
//      So this does NOT dump every record into the prompt. It builds a
//      compact context pack: the question universe, brand strategy's
//      territories and POV, the offer, and a short ICP summary. That is a
//      retrieval decision, not a token-saving one — a model given
//      everything produces generic ideas because nothing is salient.
//
//   2. "Ideation consumes the Question Universe. It never reconstructs it."
//      Every idea must cite the question or tension it answers, and those
//      are checked against the ICP records that actually exist.
//
// It generates ideas only: no hooks, scripts, captions, CTAs or briefs.
// Those are downstream and generating them here would corrupt the brief
// agent's input.

import type { SupabaseClient } from "@supabase/supabase-js";
import { anthropicKeyForAgent, type RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { ProviderError, runAgentLoop } from "../../tools/anthropic.js";
import { loadUpstreamRecords, type UpstreamRecord } from "../shared.js";
import { logger } from "../../logging/logger.js";
import { ideaSource, pillarBrief, pillarFields, type PillarScope } from "../../pillars/scope.js";
import { coerceFormat, formatFitsMedia, isContentFormat, platformAllowsFormat } from "../../content/format.js";
import type { ContentFormat } from "../../content/format.js";
import { loadSlot, SLOT_IDEA_COUNT, type SlotContext } from "../../engine/slot.js";

const DEFAULT_IDEA_COUNT = 25;

interface IdeaPayload {
  title: string;
  core_idea: string;
  content_territory: string;
  source_question: string;
  strategic_reason: string;
  media_type: "image" | "text" | "video";
  content_format: ContentFormat;
}

/**
 * The two shape fields, decided together.
 *
 * Together because they constrain each other: a carousel of video and a
 * story made of text are both contradictions, and the insert is a single
 * statement — one refused pairing would take the whole batch down with it
 * on the check constraint added in 112. An idea that contradicts itself is
 * filed as a single, which loses that idea's shape and keeps the rest.
 */
export function mediaAndFormat(entry: Record<string, unknown>): {
  media_type: IdeaPayload["media_type"];
  content_format: IdeaPayload["content_format"];
} {
  const media = (["image", "text", "video"] as const).includes(entry.media_type as never)
    ? (entry.media_type as IdeaPayload["media_type"])
    : "video";
  return { media_type: media, content_format: coerceFormat(entry.content_format, media) };
}

/**
 * The Ideation Context Pack. Deliberately a subset: the question universe
 * in full (it is the raw material), brand strategy in full (it is already
 * the compression layer), and only the offer from strategy. Competitor and
 * association records are excluded — Brand Strategy has already
 * synthesised them, and including both is how you get a prompt that says
 * everything and therefore emphasises nothing.
 */
function buildContextPack(records: UpstreamRecord[]): {
  questionUniverse: string;
  icpSummary: string;
  strategy: string;
  offer: string;
} {
  const pick = (domain: string, keys?: string[]) =>
    records
      .filter((r) => r.domain === domain && (!keys || keys.includes(r.item_key)))
      .map((r) => `**${r.title}**\n${r.body}`)
      .join("\n\n");

  return {
    questionUniverse: pick("icp", ["question-universe"]),
    // A handful of ICP sections, not all fifteen.
    icpSummary: pick("icp", [
      "avatar-role-map",
      "objections",
      "desired-outcomes",
      "language-patterns",
      "risk-and-fears",
    ]),
    strategy: pick("brand_strategy"),
    offer: pick("offer_strategy", ["dream-outcome", "guarantee"]),
  };
}

export async function runIdeationJob(
  sb: SupabaseClient,
  runtime: RuntimeConfig,
  agent: AgentRow,
  job: AgentJobRow,
  deadlineAt: number,
): Promise<JobResult> {
  if (!job.client_id) {
    return { ok: false, retryable: false, failureMessage: "Ideation jobs require a client." };
  }

  // The engine asks for ideas for one slot: one pillar, one format, a
  // handful of candidates for the selector to choose between. A person
  // asking for ideas gets the bank they have always got.
  let slot: SlotContext | null = null;
  try {
    slot = await loadSlot(sb, job);
  } catch (error) {
    return {
      ok: false,
      retryable: false,
      failureMessage: error instanceof Error ? error.message : String(error),
    };
  }

  const requested = !slot && job.params && Object.hasOwn(job.params, "target_platform")
    ? job.params : null;
  const targetPlatform = requested?.target_platform;
  const requestedMedia = requested?.media_type;
  const requestedFormat = requested?.content_format;
  if (requested && (
    typeof targetPlatform !== "string" || !isContentFormat(requestedFormat)
    || !["image", "text", "video"].includes(String(requestedMedia))
    || !formatFitsMedia(requestedFormat, String(requestedMedia))
    || !platformAllowsFormat(targetPlatform, requestedFormat)
  )) {
    return { ok: false, retryable: false, failureMessage: "The requested destination, media type and format do not form a supported idea." };
  }

  const records = await loadUpstreamRecords(sb, job.client_id, [
    "icp",
    "brand_strategy",
    "offer_strategy",
  ]);
  const pack = buildContextPack(records);

  if (!pack.questionUniverse) {
    // The architecture's hard rule. Without the question universe this
    // agent would invent one, which is exactly the failure that made v5's
    // ideation produce nothing usable.
    return {
      ok: false,
      retryable: false,
      failureMessage:
        "The ICP question universe is missing. Ideation consumes it rather than inventing one — run the ICP agent first.",
    };
  }
  if (!pack.strategy) {
    return {
      ok: false,
      retryable: false,
      failureMessage: "No brand strategy records exist. Run the Brand Strategist first.",
    };
  }

  // Proof is optional but changes what can be claimed, so it is loaded
  // rather than assumed.
  const { data: proofRows } = await sb
    .from("client_proof_assets")
    .select("title, body, source, media_type")
    .eq("client_id", job.client_id)
    .limit(20);
  const proof = (proofRows ?? [])
    .map((p) => `- ${p.title ?? "Untitled"}${p.source ? ` (${p.source})` : ""}: ${p.body ?? "[file]"}`)
    .join("\n");

  // A specific proof asset can seed the run (the Proof Idea button).
  let seededProof = "";
  if (job.input_table === "client_proof_assets" && job.input_id) {
    const { data } = await sb
      .from("client_proof_assets")
      .select("title, body, source")
      .eq("id", job.input_id)
      .maybeSingle();
    if (data) {
      seededProof = `${data.title ?? "Untitled"}${data.source ? ` (${data.source})` : ""}: ${data.body ?? "[file]"}`;
    }
  }

  // A run can be confined to one content pillar, the same way it can be
  // seeded from one proof item. An unscoped run fills a bank; a scoped run
  // fills a pillar, which is a different job with a different shape.
  let pillar: PillarScope | null = null;
  let siblings: PillarScope[] = [];
  const pillarId = slot?.pillar_id ?? (job.input_table === "client_content_pillars" ? job.input_id : null);
  if (pillarId) {
    const { data } = await sb
      .from("client_content_pillars")
      .select("id, name, premise, belongs, does_not_belong, active")
      .eq("id", pillarId)
      .maybeSingle();
    if (!data) {
      return {
        ok: false,
        retryable: false,
        failureMessage: "That content pillar no longer exists.",
      };
    }
    // A retired pillar is a decision somebody made. Generating into it would
    // quietly undo that, so it fails loudly instead.
    if (!data.active) {
      return {
        ok: false,
        retryable: false,
        failureMessage: `"${String(data.name)}" has been retired. Reinstate it before generating into it.`,
      };
    }
    pillar = {
      id: String(data.id),
      name: String(data.name),
      premise: String(data.premise),
      belongs: String(data.belongs),
      does_not_belong: String(data.does_not_belong),
    };

    // The brand's other active pillars. Without them the instruction to leave
    // out an idea that belongs elsewhere names no elsewhere, and the model
    // cannot act on it.
    const { data: others } = await sb
      .from("client_content_pillars")
      .select("id, name, premise, belongs, does_not_belong")
      .eq("client_id", job.client_id)
      .eq("active", true)
      .neq("id", pillar.id);
    siblings = (others ?? []).map((o) => ({
      id: String(o.id),
      name: String(o.name),
      premise: String(o.premise),
      belongs: String(o.belongs),
      does_not_belong: String(o.does_not_belong),
    }));
  }

  const configured = Number((agent.config as { idea_count?: unknown })?.idea_count);
  // A slot needs a few candidates to choose between, not a bank. Twenty-five
  // ideas for one post is twenty-one ideas nobody reads and a bill for all
  // of them, and the selector is choosing by score rather than by stamina.
  const ideaCount = slot
    ? SLOT_IDEA_COUNT
    : Number.isFinite(configured) && configured > 0
      ? Math.min(configured, 60)
      : DEFAULT_IDEA_COUNT;

  const submitTool = {
    name: "submit_ideas",
    description: `Submit the finished idea bank. Call this exactly once, when you have finished. Return ${ideaCount} distinct ideas.`,
    inputSchema: {
      type: "object",
      properties: {
        ideas: {
          type: "array",
          description: `The idea bank. Exactly ${ideaCount} entries.`,
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Short, memorable. The idea in a few words." },
              core_idea: { type: "string", description: "The thing worth saying, in one or two sentences." },
              content_territory: { type: "string", description: "Which content territory from the brand strategy this sits in." },
              source_question: { type: "string", description: "The ICP question or tension this answers, taken from the question universe." },
              strategic_reason: { type: "string", description: "Why this is worth saying for this business specifically." },
              media_type: { type: "string", description: "One of: image, text, video." },
              content_format: { type: "string", description: "The shape it runs in: single, carousel, story or reel. A carousel is an image set; a story is an image or video; a reel is video; text is always single. Follow any requested format exactly." },
            },
            required: ["title", "core_idea", "content_territory", "source_question", "strategic_reason", "media_type", "content_format"],
            additionalProperties: false,
          },
        },
      },
      required: ["ideas"],
      additionalProperties: false,
    },
  };

  const system = `You work for Attract Acquisition, a marketing agency. You run Ideation for a client.

Ideation determines WHAT IS WORTH SAYING. Nothing else.

WHAT YOU PRODUCE
- Ideas. An idea is a thing worth saying, expressed plainly. "Businesses with proof shouldn't be outperformed by businesses that are simply louder" is a complete idea.
- An idea needs no hook, script, caption, storyboard, shot list, CTA or thumbnail. Do not write any of those. A different agent designs how to say it, and putting production detail here corrupts its input.

WHERE IDEAS COME FROM
- The question universe is the raw material. It was built by the ICP agent from this buyer's real information needs. Consume it. Never invent questions of your own — if an idea does not trace to a question or tension that is actually in the material you were given, it does not belong in the bank.
- The brand strategy tells you which territories this business should own and what it should avoid. Stay inside them.
- Good ideas are specific to this business. An idea that would work for any company in this sector is not an idea, it is a category cliché. Delete it and write a better one.

ABSOLUTE RULES
- Never invent proof, results, figures, customers or claims. If you reference proof, it must be proof you were actually given.
- Never write placeholder or filler entries to reach the requested count. Fewer real ideas beats padding, and a repeated idea with different wording is padding.
- Vary the shape: some ideas answer a question, some challenge a misconception, some name a tension the buyer feels but has not articulated, some reframe a comparison. A bank of twenty-five explainers is a failure.`;

  const prompt = `Build an idea bank of ${ideaCount} ideas for this client.

QUESTION UNIVERSE — the raw material. Ideas trace back to these.
${pack.questionUniverse}

BRAND STRATEGY — the territories to own and the point of view to hold
${pack.strategy}

ICP — who is being spoken to
${pack.icpSummary}
${pack.offer ? `\nOFFER — what is ultimately being sold\n${pack.offer}` : ""}
${proof ? `\nPROOF ON FILE — the only proof you may reference\n${proof}` : "\nPROOF ON FILE\nNone. Do not reference any proof, results or figures."}
${seededProof ? `\nSEED THIS RUN FROM THIS PROOF ITEM SPECIFICALLY\n${seededProof}\nAt least half the ideas should build on it.` : ""}
${pillar ? `\n${pillarBrief(pillar, siblings)}` : ""}${
    slot
      ? `\nTHE SLOT THIS IS FOR\nThis is for one post, going out on ${slot.platform} as a ${slot.format}. Every idea must work in that shape: do not propose an idea whose point only lands as something else. The shape is already decided and is not yours to change.`
      : requested
        ? `\nTHE REQUESTED DESTINATION AND SHAPE\nEvery idea is for ${targetPlatform} as ${requestedMedia} in ${requestedFormat} format. Keep both media_type and content_format exactly as requested. A different shape is not usable for this run.`
        : ""
  }

Call ${submitTool.name} once when you are done.`;

  await appendEvent(
    sb,
    job.id,
    slot
      ? `Generating ${ideaCount} ${slot.format} ideas for the ${slot.platform} slot${pillar ? ` within "${pillar.name}"` : ""}.`
      : `Generating ${ideaCount} ideas from the question universe${pillar ? ` within "${pillar.name}"` : ""}${seededProof ? ", seeded from one proof item" : ""}.`,
  );

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

  const usage = {
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: result.usage.costUsd,
  };

  const raw = Array.isArray(result.submitted.ideas) ? result.submitted.ideas : [];
  const valid = raw
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({
      title: String(entry.title ?? "").trim(),
      core_idea: String(entry.core_idea ?? "").trim(),
      content_territory: String(entry.content_territory ?? "").trim(),
      source_question: String(entry.source_question ?? "").trim(),
      strategic_reason: String(entry.strategic_reason ?? "").trim(),
      ...mediaAndFormat(entry),
    }))
    // An idea with no title or no source question is not an idea by this
    // architecture's definition, so it is dropped rather than stored.
    .filter((idea) => idea.title.length > 0 && idea.core_idea.length > 20 && idea.source_question.length > 0)
    .filter((idea) => !requested || (idea.media_type === requestedMedia && idea.content_format === requestedFormat));

  if (valid.length === 0) {
    return {
      ok: false,
      retryable: true,
      failureMessage: "The model returned no usable ideas.",
      usage,
    };
  }

  // A slot run is scoped to a pillar, so that is what it is. The engine
  // showing up in this column would be a fourth kind of source that means
  // the same as the third.
  const source = slot ? "pillar" : ideaSource(job.input_table);
  const { error } = await sb.from("client_ideas").insert(
    valid.map((idea) => ({
      client_id: job.client_id,
      title: idea.title.slice(0, 300),
      body: idea.core_idea,
      ...pillarFields(pillar, idea.content_territory),
      source_question: idea.source_question,
      strategic_reason: idea.strategic_reason || null,
      media_type: idea.media_type,
      // The slot's format wins. The planner chose it from the client's mix
      // and the calendar; an idea that arrives as something else is the
      // model having a view about a decision already taken.
      content_format: slot ? slot.format : idea.content_format,
      target_platform: slot?.platform ?? (typeof targetPlatform === "string" ? targetPlatform : null),
      source,
      job_id: job.id,
      slot_id: slot?.id ?? null,
      proof_id: job.input_table === "client_proof_assets" ? job.input_id : null,
    })),
  );
  if (error) throw new Error(`Failed to write ideas: ${error.message}`);

  const dropped = raw.length - valid.length;
  logger.info("ideation_complete", { jobId: job.id, generated: raw.length, stored: valid.length });
  await appendEvent(
    sb,
    job.id,
    `Wrote ${valid.length} ideas${dropped > 0 ? ` (dropped ${dropped} that had no title, body or source question)` : ""}.`,
    "info",
    { stored: valid.length, dropped, cost_usd: usage.costUsd },
  );

  return { ok: true, retryable: false, usage };
}
