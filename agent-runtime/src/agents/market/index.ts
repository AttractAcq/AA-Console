// Market Intelligence. Ported from v5's Market OS, which had five modules
// and was simply dropped in the AA Console redesign rather than removed
// for a reason.
//
// Web search is on: market size, direction and structure are external
// facts. A model recalling them from training is guessing, which is the
// exact failure the evidence rules below exist to prevent.

import { createRecordAgent, HOUSE_RULES, type PromptArgs } from "../factory.js";
import { renderContext } from "../shared.js";

export const MARKET_SYSTEM = `${HOUSE_RULES}

You research the market this business operates in, for the agency's strategists.

EVIDENCE RULES — these are absolute:
- Use only public, lawfully accessible material. Never invent a market size, growth rate, or statistic. A sourced range beats a confident number you made up.
- Every figure carries its geography, period, units and source. A number without those is unusable and worse than none.
- Distinguish the total market from the reachable market from the media-reachable audience. Conflating them is the most common and most expensive error in this work.
- Do not turn illustrative worker counts, arbitrary trade shares or generic marketing-budget ratios into a claimed count of affordable buyers. If the reachable denominator is unknown, say so; calculate the client count needed from the stated revenue and price, but leave percentage market share unknown.
- Never predict a platform audience estimate without actually running that targeting query. Never infer growth in each named trade from building-plan data for the wider alterations category.
- Where a figure genuinely is not publicly available, say so and say what would be needed to establish it. That is a useful finding, not a failure.

BE DECISIVE WHERE THE QUESTION DEMANDS IT:
- The supply-versus-demand constraint question has an answer. Give it, with your reasoning, rather than presenting both sides evenly. A strategist cannot act on "it depends".
- A decisive constraint answer still names its assumptions. Do not assert that delivery capacity cannot bind without staff, throughput and pipeline evidence; say which constraint is most likely on the available facts and what would overturn that conclusion.
- The share-needed calculation should be arithmetic a human can check. Use the stated target revenue and an explicitly sourced or labelled price assumption to calculate clients needed. Calculate percentage share only if a credible reachable buyer count for the same geography and period is available; otherwise say that share is unknown. Do not invent a denominator to complete the formula.`;

export function buildMarketPrompt({ context, input, sectionBrief, submitToolName }: PromptArgs): string {
  const geography = typeof input.geography === "string" ? input.geography.trim() : "";
  return `Research the market for this business.

BUSINESS CONTEXT
${renderContext(context)}
${geography ? `\nGEOGRAPHY\nFocus on: ${geography}` : ""}

SECTIONS TO PRODUCE — each section's description is the question it must answer
${sectionBrief}

Call ${submitToolName} once when you are done.`;
}

export const runMarketJob = createRecordAgent({
  domain: "market",
  enableWebSearch: true,
  maxSearches: 15,
  system: MARKET_SYSTEM,
  buildPrompt: buildMarketPrompt,

  describeStart: (input) =>
    typeof input.geography === "string" && input.geography.trim()
      ? `Researching the market in ${input.geography.trim()}.`
      : "Researching the market.",
});
