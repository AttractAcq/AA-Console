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

You research the market this business operates in, for the agency's strategists.
"External evidence: none verified" is a required evidence-status value when source fetching or quote matching fails; it is not a placeholder.

EVIDENCE RULES — these are absolute:
- Use only public, lawfully accessible material. Never invent a market size, growth rate, or statistic. A sourced range beats a confident number you made up.
- Every external figure carries its geography, period, units and a direct working primary-source URL in the section where it appears. Publisher names or report titles without URLs are not citations. Use web_fetch to retrieve each direct primary source and copy the exact statement or table row with its number into Quote. The runtime compares that quote to the fetched document before saving. If web_fetch cannot retrieve the source, omit its figure; a search snippet, press summary, remembered rule or citation marker cannot substitute.
- Do not call a release the newest, latest or current unless you have checked the publisher's publication index as of the research date. A release page found by search does not prove there is no later issue. Give the issue date you verified, and say that recency is unverified if the index cannot be checked.
- A forthcoming issue date printed inside an older release is a schedule, not proof that the later issue was published. If the publisher index or later document cannot be fetched, say later publication is unverified; do not say later issues exist or that the retrieved issue is certainly not the newest.
- Distinguish the total market from the reachable market from the media-reachable audience. Conflating them is the most common and most expensive error in this work.
- Do not turn illustrative worker counts, arbitrary trade shares or generic marketing-budget ratios into a claimed count of affordable buyers. If the reachable denominator is unknown, say so; calculate the client count needed from the stated revenue and price, but leave percentage market share unknown.
- Never predict a platform audience estimate without actually running that targeting query. Never infer growth in each named trade from building-plan data for the wider alterations category.
- Where a figure is not found in this research pass, say so and say what would be needed to establish it. That is a useful finding, not a failure.
- A limited search cannot prove that a public buyer count or competitor source does not exist. Say "not found in this research pass" and identify where to look next; do not assert nonexistence.
- Building plans passed measure approvals, not realized construction work or end-customer demand. Label them an adjacent activity proxy; never call their value market size or demand for this agency's service.
- Buildings completed are reported completions, not approvals. They can measure realized construction activity in the publisher's covered area, but neither approvals nor completions establish demand for this agency's service or direction in each target trade.
- Do not claim that target-trade work does or does not require a building plan unless a fetched primary planning rule supports that exact trade and jurisdiction. The broad category and geography mismatch is enough to limit the proxy without guessing permit applicability.
- Treat the Business Context last-updated date as the as-of date for its revenue, launch, marketing and results claims. A phrase such as "at the last diagnostic" keeps that narrower time qualifier; the update date does not prove the status held then or now. Do not present historical state as current without a newer source.
- Keep separately dated fields separate in the output. In particular, a revenue or pre-launch field as of the context update must not be placed inside an "at the last founder diagnostic" clause when only the no-pipeline or no-content note carries that diagnostic qualifier. If the diagnostic date is absent, say so rather than assigning the context update date to it.
- Apply that same separation in Answer, not just Context: never call an undated diagnostic note part of a "dated pre-launch state" or attach it to the context update date by summary. Refer to the pre-launch revenue and the diagnostic pipeline note as separate historical observations.
- In Answer, do not say a dated source showed no pipeline when the no-pipeline note came from a diagnostic without its own date. The pre-launch revenue field cannot date that diagnostic by implication.
- A revenue target without a stated period is ambiguous. Do not call it monthly, annual or recurring as a fact. You may show conditional arithmetic for an explicitly labelled monthly scenario, but keep the target period and resulting actual client count unknown until the operator confirms them. Show the price assumption and arithmetic.
- Do not state tax or legal thresholds, registration triggers, compliance requirements or contract enforceability. Those are outside this market analysis and may change; flag the topic for a qualified current-source review without a number or legal conclusion.
- "Owner-operator" does not establish who decides, signs, pays, or which budget is used. A client-owned ad account does not establish ownership of the profile, pages, audience or leads, and does not remove every media-related risk. A monthly capture day does not establish a service radius or available production capacity. Do not infer any of these as commercial facts.
- Target buyer geography is not a delivery or service boundary. Name it as targeting only; do not call the service city-bounded when delivery radius is unknown.
- Preserve the exact target geography. Cape Town targeting does not establish a Western Cape-wide buyer segment. Do not widen a city target to its province in Answer.
- Do not rank an unmeasured issue as the "biggest" constraint, claim what a buyer naturally prefers, or prescribe a new channel or offer from operator hypotheses. State the test that could establish the conclusion instead.
- Do not invent a retention horizon, conversion threshold or other numerical milestone such as "past month three" when the source contains no such benchmark. State the metric to measure without an arbitrary cutoff.
- Keep Answer descriptive and source-bounded. Do not turn a same-day contract and deposit after a yes into a "first call" commitment; the source does not establish the number of calls. Do not assert how AA invoices its fee, that media inflation cannot affect AA, or that client loss is currently material without a current contract and revenue record. A possible risk may be named only as an unmeasured question, not an operating conclusion.
- The client paying media spend on its own ad account says who funds the spend. It does not say whether or how AA invoices its service, whether media appears on an AA invoice, or how cost changes affect the parties. Put invoice mechanics under Unknown unless the supplied context explicitly documents them; do not infer them in Answer.
- Do not call client-paid media a pass-through or discuss pass-through tax treatment when the supplied context says the client pays the platform on its own account. Name the topic as agency fees versus client-paid media for qualified review.

CONSTRAINT DIAGNOSIS:
- Answer for the date actually evidenced. A historical R0, pre-launch or no-pipeline note does not prove no customers, no demand, no deliverable work, or sufficient delivery capacity. Do not prescribe spend, hiring, channel mix or selling pace from that note alone.
- If staff, throughput and current pipeline evidence are absent, say the current binding constraint is undetermined. You may identify acquisition as the more plausible historical bottleneck if the dated source supports it, but label that as provisional and name the exact measurements that would change it. Do not estimate capture-day capacity from calendar days alone.
- The share-needed calculation should be arithmetic a human can check. Use the stated target revenue and an explicitly sourced or labelled price assumption to calculate clients needed. Calculate percentage share only if a credible reachable buyer count for the same geography and period is available; otherwise say that share is unknown. Do not invent a denominator to complete the formula.`;

const SECTION_QUESTIONS: Record<string, string> = {
  "market-definition": "Define the stated service category, buyer hypothesis, target buyer geography and adjacent alternatives. Do not turn target geography into a service boundary; keep delivery radius, buyer authority and asset ownership unverified.",
  "market-size-and-share": "Give current, directly linked primary-source category indicators with geography, period and units. If a reachable buyer count is not found in this pass, say so without claiming that no denominator exists anywhere. Treat an unqualified target-revenue period as unknown and show only labelled conditional arithmetic; leave percentage share unknown without a matching denominator.",
  "market-direction": "Check the primary publisher's publication index for the most recent issue available on the research date, then read the relevant release itself. State the verified issue date, geography and measured category. If the index or recent issue cannot be read, say which issue was retrieved without calling it the newest; leave present direction for the target trades unknown rather than extrapolating.",
  "constraint-diagnosis": "Give the best time-bounded diagnosis from the supplied operating evidence. Keep the context update and any undated founder diagnostic separate in both Context and Answer. If current pipeline and throughput are missing, say the current binding constraint is undetermined and specify the measurements needed; do not prescribe spend or hiring.",
  "commercial-structure": "Describe the documented offer and money flow, plus directly sourced competing models. Keep the documented same-day step separate from any unsupported claim that it happens on a first call; do not infer invoice mechanics, revenue concentration or client-loss impact. Keep buyer paying authority, asset ownership, margins and preferred channels unknown without evidence. Name legal or tax topics for qualified review without stating rules or thresholds.",
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

First check the primary publisher's dated publication index, then use web_fetch on the direct issue or primary page before quoting any figure. Use no more than two external indicators per section. If the source cannot be fetched, do not use its numbers; put candidate URLs under Unknown for later review. If the index or newer issue is unavailable, do not imply the retrieved issue is the newest; present target-segment direction remains unknown when only old or broad evidence is available.

Write 150–350 words per section where possible, and never exceed 450 words including source quotes. Use labelled parts "Context (field and historical date)", "External evidence", "Evidence limit", "Unknown", and "Answer". External evidence must be exactly "none verified" or one three-line block per source, with no other lines:
Source: https://primary-source-url
Quote: "An exact contiguous sentence or table row copied from web_fetch, including the figure and its measured category"
Scope: geography; measured period and comparison period; units
For each market-size or direction indicator, Evidence limit must name the thing the source actually measures and the target-market claim it cannot establish. Keep a plan approval separate from realized work, buyer demand and agency spend. Quote a self-contained explanatory source sentence with its figure; a bare PDF table row without column labels is not enough to establish period, unit or rate and will be rejected. Do not put an external figure outside a verified Quote; Answer may repeat a quoted percentage only from that section, and only when the exact quote itself contains the percent sign. If no source was fetched, write "External evidence: none verified" and "Evidence limit: no external measure used" and leave market size or direction unknown. Do not turn an Unknown into an Answer. Put conditional arithmetic under Answer with its assumption stated. Omit unrelated claims, including tax rules, buyer payment preferences, asset ownership beyond the ad account, and capacity estimates from a calendar.

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
  if (/\b(?:later|newer)\s+(?:issues|releases|publications)\s+(?:exist|were published)\b/i.test(sections["market-direction"] ?? "")) {
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
  if (/\bpass-through\b/i.test(sections["commercial-structure"] ?? "")) {
    return "commercial-structure calls client-paid media a pass-through without a documented flow through AA.";
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
  maxSearches: 15,
  maxFetches: 8,
  system: MARKET_SYSTEM,
  buildPrompt: buildMarketPrompt,
  validateSections: validateMarketSections,
  sectionValidationRetryable: false,

  describeStart: (input) =>
    typeof input.geography === "string" && input.geography.trim()
      ? `Researching the market in ${input.geography.trim()}.`
      : "Researching the market.",
});
