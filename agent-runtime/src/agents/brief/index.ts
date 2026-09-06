// Brief agent. Turns ONE approved idea into a production brief.
//
// This is the downstream half of the boundary ideation must not cross:
// ideation decides what is worth saying, this decides how to say and
// produce it. v5's generate-production-brief is the one part of its
// downstream chain that worked (26 real briefs), so this is a port of a
// known-good idea rather than new ground.
//
// Triggered by approve_idea_and_generate_brief(), which flips the idea to
// briefed and enqueues this with the idea id.

import type { SupabaseClient } from "@supabase/supabase-js";
import { anthropicKeyForAgent, type RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { ProviderError, runAgentLoop } from "../../tools/anthropic.js";
import { loadUpstreamRecords } from "../shared.js";

export async function runBriefJob(
  sb: SupabaseClient,
  runtime: RuntimeConfig,
  agent: AgentRow,
  job: AgentJobRow,
): Promise<JobResult> {
  if (!job.client_id) {
    return { ok: false, retryable: false, failureMessage: "Brief jobs require a client." };
  }
  if (job.input_table !== "client_ideas" || !job.input_id) {
    return {
      ok: false,
      retryable: false,
      failureMessage: "A brief needs an idea. Approve an idea on the Generation tab to create one.",
    };
  }

  const { data: idea, error: ideaError } = await sb
    .from("client_ideas")
    .select("id, title, body, media_type, content_territory, source_question, strategic_reason")
    .eq("id", job.input_id)
    .maybeSingle();
  if (ideaError) throw new Error(`Failed to load idea: ${ideaError.message}`);
  if (!idea) {
    return { ok: false, retryable: false, failureMessage: "That idea no longer exists." };
  }

  // Per-idea retrieval, not the whole corpus — same discipline as
  // ideation, and the reason the architecture calls this "progressive
  // compute": briefs are deeper but there are far fewer of them.
  const records = await loadUpstreamRecords(sb, job.client_id, ["icp", "brand_strategy"]);
  const voice = records
    .filter((r) => ["language-patterns", "objections", "risk-and-fears"].includes(r.item_key))
    .map((r) => `**${r.title}**\n${r.body}`)
    .join("\n\n");
  const strategy = records
    .filter((r) => r.domain === "brand_strategy")
    .map((r) => `**${r.title}**\n${r.body}`)
    .join("\n\n");

  const { data: proofRows } = await sb
    .from("client_proof_assets")
    .select("title, body, source")
    .eq("client_id", job.client_id)
    .limit(15);
  const proof = (proofRows ?? [])
    .map((p) => `- ${p.title ?? "Untitled"}${p.source ? ` (${p.source})` : ""}: ${p.body ?? "[file]"}`)
    .join("\n");

  const submitTool = {
    name: "submit_brief",
    description: "Submit the finished production brief. Call this exactly once.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short production title for this piece." },
        brief: { type: "string", description: "The full brief, in the structure requested." },
      },
      required: ["title", "brief"],
      additionalProperties: false,
    },
  };

  const system = `You work for Attract Acquisition, a marketing agency. You write production briefs.

An editor or avatar who has never seen this client should be able to make the piece from your brief without asking a question.

WHAT A BRIEF CONTAINS
- The idea, restated in one line so the maker knows what they are actually saying.
- The angle: how this specific piece expresses that idea.
- Structure appropriate to the format — for video, what happens across the opening seconds, the body, and the close; for a carousel, what each frame carries; for a static or text piece, the single message and its supporting points.
- What must be shown or said, and what must not.
- Practical production notes: location, props, wardrobe, on-screen text, anything the maker has to arrange.

ABSOLUTE RULES
- Only reference proof you were actually given. If there is none on file, the piece must work without a claim — say so explicitly in the brief rather than leaving the maker to invent one.
- Respect the brand voice and anything the strategy says to avoid.
- Do not invent statistics, results, prices, timelines or customer quotes. A brief that requires an invented fact is a brief that will get one invented.
- Be concrete. "Make it engaging" tells a maker nothing. "Open on the founder holding the failed implant that was removed, no talking, three seconds" tells them everything.`;

  const prompt = `Write a production brief for this approved idea.

THE IDEA
Title: ${idea.title}
Core idea: ${idea.body ?? ""}
${idea.source_question ? `Answers this buyer question: ${idea.source_question}` : ""}
${idea.strategic_reason ? `Why it matters: ${idea.strategic_reason}` : ""}
${idea.content_territory ? `Content territory: ${idea.content_territory}` : ""}
Format: ${idea.media_type}

BRAND STRATEGY — hold this point of view, respect what it says to avoid
${strategy || "(none on file)"}

BUYER LANGUAGE, OBJECTIONS AND FEARS — speak to these, in their words
${voice || "(none on file)"}

PROOF ON FILE — the only proof this piece may reference
${proof || "None. The piece must work without a proof claim; say so in the brief."}

Call ${submitTool.name} once when you are done.`;

  await appendEvent(sb, job.id, `Writing brief for "${idea.title}".`);

  let result;
  try {
    result = await runAgentLoop({
      apiKey: anthropicKeyForAgent(runtime, agent.agent_key),
      model: runtime.model,
      timeoutMs: runtime.providerTimeoutMs,
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

  const title = String(result.submitted.title ?? "").trim() || idea.title;
  const body = String(result.submitted.brief ?? "").trim();
  if (body.length < 200) {
    return {
      ok: false,
      retryable: true,
      failureMessage: "The brief came back too short to be usable.",
      usage,
    };
  }

  const { error } = await sb.from("client_briefs").insert({
    client_id: job.client_id,
    source_idea_id: idea.id,
    title: title.slice(0, 300),
    body,
    media_type: idea.media_type,
    status: "draft",
    job_id: job.id,
  });
  if (error) throw new Error(`Failed to write brief: ${error.message}`);

  await appendEvent(sb, job.id, `Wrote brief "${title}".`, "info", { cost_usd: usage.costUsd });
  return { ok: true, retryable: false, usage };
}
