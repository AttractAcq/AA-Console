// Market Intelligence. Ported from v5's Market OS, which had five modules
// and was simply dropped in the AA Console redesign rather than removed
// for a reason.
//
// Web search is on: market size, direction and structure are external
// facts. A model recalling them from training is guessing, which is the
// exact failure the evidence rules below exist to prevent.

import { createRecordAgent, HOUSE_RULES, type PromptArgs } from "../factory.js";
import { renderContext } from "../shared.js";
import type { FetchedSource } from "../../tools/source-text.js";
import { verifyMarketSourceClaims } from "./source-verification.js";

export const MARKET_SYSTEM = `${HOUSE_RULES}

You research Market Intelligence for strategists. Keep each section short. A useful unknown is better than an unsupported conclusion.

EXTERNAL SOURCE CONTRACT
- Use public, lawfully accessible primary sources only. Before using an external fact, fetch its direct URL and copy one exact, self-contained source sentence into Quote. Add Source and Scope with geography, measured period, comparison period and units. A search snippet, remembered fact, publisher name or bare table row is not evidence. If the document cannot be fetched and inspected, write "External evidence: none verified" and leave its measure unknown.
- Check the publisher's dated index before calling an issue current, newest or latest. A forthcoming date in an older issue is a schedule, not proof of publication. If the index is unavailable, state the issue actually read and leave recency unverified.
- Separate total market, reachable buyers and media-reachable audience. A broad construction indicator does not count buyers or agency spend. Building plans passed are approvals; buildings completed are reported completions. Neither establishes demand or direction for each target trade. Do not infer whether a trade needs a permit without a fetched primary rule.
- A limited research pass cannot prove a public count or competitor source does not exist. Say "not found in this pass". Quote explicit current competitor terms before comparing billing models; paying per contact alone does not prove there is no monthly fee.

BUSINESS CONTEXT CONTRACT
- Date each field by its own source. The context update does not date an embedded founder diagnostic. Separate historical revenue, launch and pipeline observations in Context and Answer. Missing current records are "not supplied", not proven nonexistent.
- Treat operator descriptions of buyers, competitors and seasonality as hypotheses. A target city is not a delivery radius or a province-wide segment. "Owner-operator" does not establish the signer, payer or budget. A client-funded ad account does not establish ownership of pages, profiles, audiences or leads, how AA invoices, or media-cost effects.
- A revenue target without a period stays unknown. You may show labelled one-month arithmetic from stated prices, but cannot claim actual clients or share without a matching reachable-buyer denominator. If current pipeline and delivery throughput are missing, the current binding constraint is undetermined; a historical diagnosis may be labelled provisional.
- Do not invent capacity, retention cutoffs, conversion thresholds, invoice milestones or causal commercial risks. State the measurement needed instead. Do not state tax or legal thresholds or enforceability; flag the topic for qualified current-source review.

OUTPUT CONTRACT
- Each Answer gives only the bounded conclusion and one next measurement or source gap. Avoid repeating the instructions and avoid speculative strategy. Every material statement must trace to a supplied Business Context field, a fetched exact quote or a clearly labelled inference. If none supports it, omit it.
- "External evidence: none verified" is a valid evidence-status value, not a placeholder.`;
const SECTION_QUESTIONS: Record<string, string> = {
  "market-definition": "State the service, hypothesised buyer and target geography. Keep delivery radius, buyer authority and asset ownership unknown.",
  "market-size-and-share": "Use at most one verified category indicator. Keep reachable buyer count and market share unknown without a matching denominator; show only conditional target-price arithmetic.",
  "market-direction": "Check the publisher index and quote at most one relevant primary measure. If recency or trade-level direction cannot be verified, leave present direction unknown.",
  "constraint-diagnosis": "Separate the context update from an undated diagnostic. If current pipeline and throughput are absent, leave the current binding constraint undetermined and name the measurements needed.",
  "commercial-structure": "Describe the documented offer and client-funded media. Use a competitor model only when its fetched terms explicitly establish the comparison. Leave invoice mechanics, authority, margins, ownership and preferences unknown.",
};

export function buildMarketPrompt({ context, input, templates, submitToolName }: PromptArgs): string {
  const geography = typeof input.geography === "string" ? input.geography.trim() : "";
  const marketContext = context && { ...context, brand_voice: null, proof_testimonials: null };
  const sectionBrief = templates.map((template) =>
    `- ${template.item_key}: ${template.title} — ${SECTION_QUESTIONS[template.item_key] ?? template.description ?? "Answer only from verified evidence; state what remains unknown."}`,
  ).join("\n");
  return `Research the market for this business.

RESEARCH DATE
${new Date().toISOString().slice(0, 10)}. Verify current public facts as of this date; the Business Context may be historical.

BUSINESS CONTEXT
${renderContext(marketContext)}
${geography ? `\nGEOGRAPHY\nFocus on: ${geography}` : ""}

SECTIONS TO PRODUCE — each section's description is the question it must answer
${sectionBrief}

Use no more than one external indicator in market-size-and-share and one in market-direction. Search for the publisher's dated index first; if it or the issue is inaccessible, report the gap rather than filling it from snippets. Fetch each cited source directly.

Keep each section near 150–250 words, including its quote. Use these five labelled parts: "Context (field and historical date)", "External evidence", "Evidence limit", "Unknown", "Answer". External evidence must be exactly "none verified" or one three-line block per source, with no other lines:
Source: https://primary-source-url
Quote: "One exact self-contained sentence copied from web_fetch, including the measured category and figure"
Scope: geography; measured period and comparison period; units
Evidence limit must state what the source measures and what it cannot establish about this buyer market. Keep Answer to one or two bounded sentences; put source gaps in Unknown. If no source was fetched, write "External evidence: none verified" and "Evidence limit: no external measure used". Do not put an external number outside its matched Quote, except Answer may repeat a percentage from that same section's quote. Put conditional arithmetic under Answer with its assumption.

Call ${submitToolName} once when you are done.`;
}

export function validateMarketSections(
  sections: Record<string, string>, fetchedSources: FetchedSource[] = [],
): string | null {
  for (const [key, body] of Object.entries(sections)) {
    for (const label of ["Context", "External evidence", "Evidence limit", "Unknown", "Answer"]) {
      if (!body.toLowerCase().includes(label.toLowerCase())) {
        return `${key} needs a ${label} part before it can be saved.`;
      }
    }
    if (body.trim().split(/\s+/).length > 500) {
      return `${key} is too long to audit as a sourced market conclusion.`;
    }
  }
  if (/\b(?:newest|latest)\s+(?:relevant\s+)?(?:release|issue|publication)\s+(?:identified|is|was|available)\b/i.test(sections["market-direction"] ?? "")) {
    return "market-direction must give a verified issue date without an absolute recency claim.";
  }
  const direction = sections["market-direction"] ?? "";
  for (const match of direction.matchAll(/\b(?:later|newer)\s+(?:issues|releases|publications)\s+(?:exist|were published)\b/gi)) {
    const prefix = direction.slice(Math.max(0, (match.index ?? 0) - 60), match.index).split(/[.!?\n]/).at(-1) ?? "";
    if (/(?:do not claim|cannot (?:confirm|establish)|not proof that)\s*$/i.test(prefix)) continue;
    return "market-direction cannot infer later publication from a release schedule.";
  }
  const constraint = sections["constraint-diagnosis"] ?? "";
  const diagnosticUndated = /\b(?:undated (?:founder )?diagnostic|diagnostic date (?:is )?(?:absent|unknown|not given)|date of (?:that |the )?diagnostic (?:is )?(?:absent|unknown|not given))\b/i.test(constraint);
  const constraintAnswer = constraint.split(/\bAnswer\s*[:—–-]/i).at(-1) ?? "";
  if (diagnosticUndated && /\bdated\b[^.!?\n]{0,140}\bno (?:recorded )?pipeline\b/i.test(constraintAnswer)) {
    return "constraint-diagnosis attaches an undated pipeline note to dated context.";
  }
  const commercialAnswer = (sections["commercial-structure"] ?? "").split(/\bAnswer\s*[:—–-]/i).at(-1) ?? "";
  if (/\bfirst call\b|\b(?:AA|agency)\s+(?:invoices|bills)\b|\boutside\s+(?:AA's|the agency's)\s+invoice\b|\bmedia inflation\b/i.test(commercialAnswer)) {
    return "commercial-structure infers unsupported call, invoice or media-cost mechanics.";
  }
  if (/\bfirst monthly invoice\b/i.test(commercialAnswer)) {
    return "commercial-structure assumes a monthly invoice despite undocumented fee billing.";
  }
  if (/\bno current (?:contract|invoice|revenue) records? exists?\b/i.test(Object.values(sections).join("\n"))) {
    return "Market treats a missing current record in the supplied material as proven nonexistence.";
  }
  if (/\bpass-through\b/i.test(sections["commercial-structure"] ?? "")) {
    return "commercial-structure calls client-paid media a pass-through without a documented flow through AA.";
  }
  if (/\b(?:rather than|instead of)\s+(?:per month|a monthly|monthly)\b|\b(?:no monthly fee|no subscription)\b/i.test(commercialAnswer)
    && !/^Quote:.*\b(?:no monthly fee|no subscription|without a monthly fee)\b/im.test(sections["commercial-structure"] ?? "")) {
    return "commercial-structure infers the absence of monthly competitor fees without a matched source statement.";
  }
  if (/\b(?:much|most|some)\b[^.!?\n]{0,80}\b(?:work|jobs)\b[^.!?\n]{0,30}\b(?:needs?|requires?)\s+no\s+(?:building\s+)?plan\b/i.test(sections["market-direction"] ?? "")) {
    return "market-direction asserts unverified planning-permit applicability for the target trades.";
  }
  const allText = Object.values(sections).join("\n");
  const absenceClaim = /\bno public (?:source|count|register|dataset|data)\b[^.!?]{0,80}\bexists\b/gi;
  for (const match of allText.matchAll(absenceClaim)) {
    const prefix = allText.slice(Math.max(0, (match.index ?? 0) - 80), match.index).split(/[.!?\n]/).at(-1) ?? "";
    if (/(?:not proof that|cannot (?:establish|conclude|say) that|does not (?:show|mean|prove)(?: that)?)\s*$/i.test(prefix)) continue;
    return "A research pass cannot establish that a public source does not exist.";
  }
  return verifyMarketSourceClaims(sections, fetchedSources);
}

export const runMarketJob = createRecordAgent({
  domain: "market",
  enableWebSearch: true,
  enableWebFetch: true,
  maxSearches: 6,
  maxFetches: 4,
  system: MARKET_SYSTEM,
  buildPrompt: buildMarketPrompt,
  validateSections: validateMarketSections,
  sectionValidationRetryable: false,

  describeStart: (input) =>
    typeof input.geography === "string" && input.geography.trim()
      ? `Researching the market in ${input.geography.trim()}.`
      : "Researching the market.",
});
