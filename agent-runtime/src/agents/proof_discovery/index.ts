// Proof Finder.
//
// Most of a business's proof is already published and nobody has time to go
// and find it. This searches for it and files each find as a structured
// record.
//
// Two rules shape everything here. Nothing is invented — a claim without a URL
// somebody can open is worse than nothing, because it looks like evidence. And
// nothing is cleared: finding a review is not permission to use it in
// advertising, and this agent cannot know whether a customer agreed to be
// quoted. A person decides that.

import type { SupabaseClient } from "@supabase/supabase-js";
import { anthropicKeyForAgent, type RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { ProviderError, runAgentLoop } from "../../tools/anthropic.js";

const PROOF_TYPES = [
  "customer_result", "testimonial", "review", "case_study", "before_after",
  "stat", "credential", "award", "press", "process", "team_expertise", "customer_story",
];

const SYSTEM = `You find proof that a business has already published, using web search.

WHAT COUNTS AS PROOF
Anything a sceptical buyer would accept as evidence that this business does what it says: reviews and ratings on any platform, testimonials, case studies, published results, press coverage, awards, accreditations, professional registrations, named team credentials, before-and-after work, or a directory listing carrying a rating and a review count.

HOW TO SEARCH
Search for the business by name together with its town, its website domain, and the platforms its sector actually uses. Try the review sites, the trade directories and the professional registers, not only the first page of a single query. A business with nothing on page one often has a great deal on a register or a directory.

ABSOLUTE RULES
- Every record must carry a URL you actually saw in search results. No URL, no record.
- Never invent a review, a rating, a quotation, a figure or an award. If you cannot find the wording, say what you did find and leave the quotation out.
- Never guess a star rating or a review count. Report only numbers that appeared.
- Do not report the business's own marketing claims as proof. "We are the leading provider" on their own homepage is a claim, not evidence. A case study with a named client and a result is evidence.
- If a find is about a different business with a similar name, discard it. Check the town and the domain.
- Report honestly when there is little or nothing. An empty result is a finding; a fabricated one is a liability.

STRENGTH
- high: a named customer result with detail, a substantial body of reviews with a rating, a professional registration, a genuine award, press in a real publication.
- medium: a handful of reviews, a directory listing, an unnamed testimonial, a trade body membership.
- low: a passing mention, a single old review, anything thin.`;

const submitTool = {
  name: "submit_proof",
  description: "Submit every piece of proof you found. Call this exactly once, even if you found nothing.",
  inputSchema: {
    type: "object",
    properties: {
      found: {
        type: "array",
        description: "One entry per distinct piece of proof. Empty if you genuinely found none.",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short label for this find, as a person would refer to it." },
            proof_type: { type: "string", enum: PROOF_TYPES, description: "What kind of proof this is." },
            claim: { type: "string", description: "The one specific thing this proves, in a sentence." },
            evidence: { type: "string", description: "What you actually saw, including any real numbers and quoted wording." },
            source: { type: "string", description: "The URL you found it at. Required - a find with no URL must not be submitted." },
            strength: { type: "string", enum: ["high", "medium", "low"] },
            avatar_relevance: { type: "string", description: "Which buyer this lands with, or empty if it is general." },
            services: { type: "string", description: "Which service it relates to, or empty." },
          },
          required: ["title", "proof_type", "claim", "evidence", "source", "strength", "avatar_relevance", "services"],
          additionalProperties: false,
        },
      },
      searched: { type: "string", description: "Where you looked, so a person can see what was covered and what was not." },
      nothing_found_because: { type: "string", description: "If found is empty, why. Empty string otherwise." },
    },
    required: ["found", "searched", "nothing_found_because"],
    additionalProperties: false,
  },
};

export interface Found {
  title?: unknown;
  proof_type?: unknown;
  claim?: unknown;
  evidence?: unknown;
  source?: unknown;
  strength?: unknown;
  avatar_relevance?: unknown;
  services?: unknown;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** A find is only usable if somebody can go and check it. */
export function isUsableFind(f: Found): boolean {
  return Boolean(str(f.claim)) && /^https?:\/\/\S+$/i.test(str(f.source));
}

/** Same source, or the same claim, means we already have it. */
export function isDuplicate(
  f: Found,
  existing: Array<{ source: string | null; claim: string | null }>,
): boolean {
  const source = str(f.source).replace(/\/+$/, "").toLowerCase();
  const claim = str(f.claim).toLowerCase();
  return existing.some(
    (e) =>
      (source !== "" && (e.source ?? "").replace(/\/+$/, "").toLowerCase() === source) ||
      (claim !== "" && (e.claim ?? "").toLowerCase() === claim),
  );
}

/**
 * Turns what the model submitted into rows worth storing.
 *
 * Extracted so the two properties that matter most are testable: that nothing
 * a machine found is ever cleared for use, and that the same proof is not
 * filed again on every run. Both were mutable without a single test failing
 * while this logic lived inline in the job.
 */
export function toProofRows(
  found: Found[],
  existing: Array<{ source: string | null; claim: string | null }>,
  clientId: string,
) {
  return found
    .filter(isUsableFind)
    .filter((f) => !isDuplicate(f, existing))
    .map((f) => ({
      client_id: clientId,
      media_type: "text" as const,
      title: str(f.title).slice(0, 300) || str(f.claim).slice(0, 300),
      body: str(f.evidence),
      source: str(f.source),
      proof_type: PROOF_TYPES.includes(str(f.proof_type)) ? str(f.proof_type) : null,
      claim: str(f.claim),
      evidence: str(f.evidence),
      avatar_relevance: str(f.avatar_relevance) || null,
      services: str(f.services) || null,
      strength: ["high", "medium", "low"].includes(str(f.strength)) ? str(f.strength) : "medium",
      // Never cleared by a machine. Finding a review is not permission to use
      // it, and this agent cannot know whether a customer agreed to be quoted.
      usage_rights: "not_cleared" as const,
    }));
}

export async function runProofDiscoveryJob(
  sb: SupabaseClient,
  config: RuntimeConfig,
  agent: AgentRow,
  job: AgentJobRow,
  deadlineAt: number,
): Promise<JobResult> {
  if (!job.client_id) {
    return { ok: false, retryable: false, failureMessage: "Proof discovery needs a client." };
  }

  const [{ data: client }, { data: contact }, { data: context }, { data: existing }] =
    await Promise.all([
      sb.from("clients").select("name, sector").eq("id", job.client_id).maybeSingle(),
      sb
        .from("client_contact_details")
        .select("website, instagram, facebook, address")
        .eq("client_id", job.client_id)
        .maybeSingle(),
      sb
        .from("client_business_context")
        .select("business_overview, main_offer")
        .eq("client_id", job.client_id)
        .maybeSingle(),
      sb.from("client_proof_assets").select("source, claim").eq("client_id", job.client_id),
    ]);

  if (!client) {
    return { ok: false, retryable: false, failureMessage: "That client no longer exists." };
  }

  const c = (contact ?? {}) as Record<string, string | null>;
  const known = [
    `Business name: ${client.name}`,
    client.sector ? `Sector: ${client.sector}` : null,
    c.website ? `Website: ${c.website}` : null,
    c.address ? `Address: ${c.address}` : null,
    c.instagram ? `Instagram: ${c.instagram}` : null,
    c.facebook ? `Facebook: ${c.facebook}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const already = (existing ?? []) as Array<{ source: string | null; claim: string | null }>;
  const alreadyText = already.length
    ? already.map((e) => `- ${e.claim ?? "(no claim)"}${e.source ? ` — ${e.source}` : ""}`).join("\n")
    : "(nothing on file yet)";

  const prompt = `Find the proof this business has already published.

WHO THEY ARE
${known}
${context?.business_overview ? `\nWhat they do: ${context.business_overview}` : ""}
${context?.main_offer ? `Main offer: ${context.main_offer}` : ""}

ALREADY ON FILE — do not submit these again
${alreadyText}

Search thoroughly, then call ${submitTool.name} once. Submit only finds you can point at with a URL.`;

  await appendEvent(sb, job.id, `Searching for published proof for ${client.name}.`);

  let result;
  try {
    result = await runAgentLoop({
      apiKey: anthropicKeyForAgent(config, agent.agent_key),
      model: config.model,
      timeoutMs: config.providerTimeoutMs,
      deadlineAt,
      system: SYSTEM,
      prompt,
      submitTool,
      enableWebSearch: true,
      onProgress: (note) => void appendEvent(sb, job.id, note),
    });
  } catch (error) {
    if (error instanceof ProviderError) {
      return {
        ok: false,
        retryable: error.retryable,
        failureMessage: error.message,
        usage: error.usage
          ? { inputTokens: error.usage.inputTokens, outputTokens: error.usage.outputTokens, costUsd: error.usage.costUsd }
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

  const raw = Array.isArray(result.submitted.found) ? (result.submitted.found as Found[]) : [];
  const unusable = raw.filter((f) => !isUsableFind(f)).length;
  const rows = toProofRows(raw, already, job.client_id);

  if (rows.length > 0) {
    const { error } = await sb.from("client_proof_assets").insert(rows);
    if (error) throw new Error(`Could not file the proof found: ${error.message}`);
  }

  const searched = str(result.submitted.searched);
  const because = str(result.submitted.nothing_found_because);
  const skipped = raw.length - unusable - rows.length;

  await appendEvent(
    sb,
    job.id,
    rows.length === 0
      ? `Found nothing new to file. ${because || searched}`
      : `Filed ${rows.length} proof record${rows.length === 1 ? "" : "s"}, all awaiting clearance.` +
          (skipped > 0 ? ` ${skipped} already on file.` : "") +
          (unusable > 0 ? ` ${unusable} discarded for having no source URL.` : ""),
    "info",
    { cost_usd: usage.costUsd },
  );

  return { ok: true, retryable: false, usage };
}
