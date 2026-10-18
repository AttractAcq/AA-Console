/**
 * The words that go out with the post.
 *
 * M3.8. The asset exists and the slot knows where it is going, so this writes
 * the caption, hashtags, alt text and first comment for that one platform and
 * files them against the asset through set_post_copy.
 *
 * Against the asset rather than the scheduled post, deliberately: there is no
 * scheduled post yet — a slot does not get one until a person approves it and
 * it reaches 'scheduled'. Asset-level copy is exactly what M0.2 built for
 * this, "the draft a post inherits", and when the post is finally made it
 * carries these words unless somebody edits them for that slot.
 *
 * The limits are not described to the model and then hoped for. checkCopy
 * from the shared platform-limits module decides, the model gets one chance
 * to fix what it got wrong, and a second failure is a refusal rather than a
 * third attempt — the same shape as the editor's EDL validation, for the same
 * reason: a model told twice and still wrong is not going to be right on the
 * third go, and each go costs.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { anthropicKeyForAgent, type RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { runAgentLoop } from "../../tools/anthropic.js";
import { loadIdentity, identityWriterBlock } from "../identity.js";
import { loadUpstreamRecords } from "../shared.js";
import { logger } from "../../logging/logger.js";
import { advanceSlot, loadSlot, type SlotContext } from "../../engine/slot.js";
import {
  checkCopy,
  isPlatform,
  PLATFORM_LIMITS,
  platformName,
  type CopyDraft,
  type Platform,
} from "../../content/platform-limits.js";

export interface CopyPayload {
  caption: string;
  hashtags: string[];
  alt_text: string;
  first_comment: string;
  cta: string;
}

/** Untrusted model output to the shape set_post_copy takes. */
export function parseCopy(raw: unknown): CopyPayload {
  const entry = (raw ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const tags = Array.isArray(entry.hashtags)
    ? entry.hashtags.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean)
    : [];
  return {
    caption: text(entry.caption),
    hashtags: tags,
    alt_text: text(entry.alt_text),
    first_comment: text(entry.first_comment),
    cta: text(entry.cta),
  };
}

/** Everything wrong with this copy, platform limits included. */
export function copyProblems(platform: Platform, copy: CopyPayload, banned: readonly string[]): string[] {
  const draft: CopyDraft = {
    caption: copy.caption,
    hashtags: copy.hashtags,
    alt_text: copy.alt_text,
    first_comment: copy.first_comment,
  };
  const problems = checkCopy(platform, draft);

  if (!copy.caption) problems.push("There is no caption.");

  // The brand's own list. Checked here as well as in QA because catching it
  // now costs one revise and catching it later costs a rebuild.
  const haystack = [copy.caption, copy.first_comment, copy.cta, copy.hashtags.join(" ")]
    .join(" ")
    .toLowerCase();
  for (const phrase of banned) {
    const needle = phrase.trim().toLowerCase();
    if (needle && haystack.includes(needle)) {
      problems.push(`The copy uses "${phrase.trim()}", which the brand does not say.`);
    }
  }
  return problems;
}

interface BriefRow {
  title: string | null;
  hook: string | null;
  premise: string | null;
  argument: string | null;
  call_to_action: string | null;
  script: string | null;
  channel_intent: string | null;
}

function briefBlock(brief: BriefRow | null): string {
  if (!brief) return "No brief on file. Work from the asset and the strategy alone.";
  const lines = [
    brief.title ? `Title: ${brief.title}` : null,
    brief.hook ? `Hook: ${brief.hook}` : null,
    brief.premise ? `Premise: ${brief.premise}` : null,
    brief.argument ? `Argument: ${brief.argument}` : null,
    brief.script ? `Script: ${brief.script}` : null,
    brief.call_to_action ? `Call to action: ${brief.call_to_action}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

export async function runCopywriterJob(
  sb: SupabaseClient,
  runtime: RuntimeConfig,
  agent: AgentRow,
  job: AgentJobRow,
  deadlineAt: number,
): Promise<JobResult> {
  let slot: SlotContext | null;
  try {
    slot = await loadSlot(sb, job);
  } catch (error) {
    return {
      ok: false,
      retryable: false,
      failureMessage: error instanceof Error ? error.message : String(error),
    };
  }
  if (!slot) {
    return {
      ok: false,
      retryable: false,
      failureMessage: "The copywriter only runs for a slot, and this job has none.",
    };
  }
  if (!isPlatform(slot.platform)) {
    return {
      ok: false,
      retryable: false,
      failureMessage: `This slot is for "${slot.platform}", which has no limits on file.`,
    };
  }
  const platform: Platform = slot.platform;

  if (!slot.asset_id) {
    // Copy describes something. Writing it before the asset exists would be
    // writing about a thing nobody has seen.
    return {
      ok: false,
      retryable: false,
      failureMessage: "This slot has no asset yet, so there is nothing for the copy to be about.",
    };
  }

  const [{ data: briefRow }, { data: brand }, { data: client }] = await Promise.all([
    slot.brief_id
      ? sb
          .from("client_briefs")
          .select("title, hook, premise, argument, call_to_action, script, channel_intent")
          .eq("id", slot.brief_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    sb.from("client_brand_profiles").select("never_do").eq("client_id", slot.client_id).maybeSingle(),
    sb.from("clients").select("name").eq("id", slot.client_id).maybeSingle(),
  ]);

  const brief = (briefRow ?? null) as BriefRow | null;
  const banned = String((brand as { never_do?: string } | null)?.never_do ?? "")
    .split(/[\n,;]+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const businessName = String((client as { name?: string } | null)?.name ?? "This business");
  const identity = await loadIdentity(sb, slot.client_id, businessName);
  const strategy = await loadUpstreamRecords(sb, slot.client_id, ["brand_strategy"]);
  const voice = strategy.map((r) => `**${r.title}**\n${r.body}`).join("\n\n");

  const limits = PLATFORM_LIMITS[platform];
  const name = platformName(platform);

  const submitTool = {
    name: "submit_copy",
    description: `The finished copy for ${name}. Call this exactly once.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["caption", "hashtags", "alt_text", "first_comment", "cta"],
      properties: {
        caption: { type: "string", description: `The post itself. At most ${limits.caption} characters.` },
        hashtags: {
          type: "array",
          items: { type: "string" },
          description: `At most ${limits.hashtags}. Letters, numbers and underscores only.`,
        },
        alt_text: {
          type: "string",
          description: limits.altText
            ? `What the image shows, for someone who cannot see it. At most ${limits.altText} characters. Empty string if there is nothing visual to describe.`
            : `${name} has no alt text. Return an empty string.`,
        },
        first_comment: {
          type: "string",
          description: limits.firstComment
            ? "Posted straight after. Empty string if nothing belongs there."
            : `${name} has no first comment. Return an empty string.`,
        },
        cta: { type: "string", description: "The ask, in a few words. Empty string if the caption carries it." },
      },
    },
  };

  const system = `You write social copy for one business, in its own voice.

WHAT YOU ARE WRITING
One post for ${name}. The picture or video already exists and the brief says what it argues. Your job is the words that go with it, not a summary of it.

ABSOLUTE RULES
- Never invent a figure, a result, a customer, a testimonial or a claim. If the brief does not say it, it does not go in.
- Never invent contact details. Use only the ones you are given, character for character.
- Write what this business would say. A caption that would suit any company in the sector is not copy, it is filler.
- ${limits.linkInBody ? "A link in the caption is clickable here, so it may go there." : `A link in a ${name} caption is not clickable. Do not put one in.`}
- Say the thing. Do not open with a question you then answer, and do not end with a line about engagement.`;

  const prompt = `Write the ${name} copy for this post.

THE BRIEF
${briefBlock(brief)}

THE BRAND'S VOICE
${voice || "No brand strategy on file. Keep it plain and specific."}

${identityWriterBlock(identity)}
${banned.length ? `\nTHE BRAND NEVER SAYS\n${banned.map((b) => `- ${b}`).join("\n")}` : ""}

LIMITS FOR ${name.toUpperCase()}
- Caption: at most ${limits.caption} characters.
- Hashtags: at most ${limits.hashtags}.
- Alt text: ${limits.altText ? `at most ${limits.altText} characters` : "not supported, return an empty string"}.
- First comment: ${limits.firstComment ? "supported" : "not supported, return an empty string"}.

Call ${submitTool.name} once when you are done.`;

  await appendEvent(sb, job.id, `Writing the ${name} copy.`);

  const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const addUsage = (u: { inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined) => {
    usage.inputTokens += u?.inputTokens ?? 0;
    usage.outputTokens += u?.outputTokens ?? 0;
    usage.costUsd += u?.costUsd ?? 0;
  };

  let result = await runAgentLoop({
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
  addUsage(result.usage);

  let copy = parseCopy(result.submitted);
  let problems = copyProblems(platform, copy, banned);

  if (problems.length > 0) {
    await appendEvent(sb, job.id, `The first draft had ${problems.length} problem(s). Asking for a revision.`, "warn", {
      problems,
    });
    result = await runAgentLoop({
      apiKey: anthropicKeyForAgent(runtime, agent.agent_key),
      model: runtime.model,
      timeoutMs: runtime.providerTimeoutMs,
      deadlineAt,
      system,
      prompt: `${prompt}

Your draft could not be used. Fix every problem below and submit the whole thing again.
${problems.map((p) => `- ${p}`).join("\n")}

Previous draft:
${JSON.stringify(copy)}`,
      submitTool,
      enableWebSearch: false,
      onProgress: (note) => void appendEvent(sb, job.id, note),
    });
    addUsage(result.usage);
    copy = parseCopy(result.submitted);
    problems = copyProblems(platform, copy, banned);
  }

  if (problems.length > 0) {
    // Told twice. A third go costs the same and is no more likely to land.
    const message = `The copy could not be used: ${problems.join(" ")}`;
    await appendEvent(sb, job.id, message, "error", { problems });
    return { ok: false, retryable: false, failureMessage: message, usage };
  }

  const { error } = await sb.rpc("set_post_copy", {
    p_platform: platform,
    p_asset_id: slot.asset_id,
    p_caption: copy.caption,
    p_hashtags: copy.hashtags,
    p_alt_text: copy.alt_text || undefined,
    p_first_comment: copy.first_comment || undefined,
    p_cta: copy.cta || undefined,
    p_source: "agent",
  } as never);
  if (error) throw new Error(`Could not save the copy: ${error.message}`);

  await advanceSlot(sb, slot.id, "qa", {
    agentKey: agent.agent_key,
    jobId: job.id,
    costUsd: usage.costUsd,
    note: `${name} copy written.`,
  });

  logger.info("copy_written", { jobId: job.id, slotId: slot.id, platform });
  await appendEvent(sb, job.id, `Wrote the ${name} copy and sent the slot to QA.`, "info", {
    caption_chars: copy.caption.length,
    hashtags: copy.hashtags.length,
    cost_usd: usage.costUsd,
  });

  return { ok: true, retryable: false, usage };
}
