// Market Intelligence. Ported from v5's Market OS, which had five modules
// and was simply dropped in the AA Console redesign rather than removed
// for a reason.
//
// Web search is on: market size, direction and structure are external
// facts. A model recalling them from training is guessing, which is the
// exact failure the evidence rules below exist to prevent.

import { createRecordAgent, HOUSE_RULES } from "../factory.js";
import { renderContext } from "../shared.js";

export const runMarketJob = createRecordAgent({
  domain: "market",
  enableWebSearch: true,
  maxSearches: 15,

  system: `${HOUSE_RULES}

You research the market this business operates in, for the agency's strategists.

EVIDENCE RULES — these are absolute:
- Use only public, lawfully accessible material. Never invent a market size, growth rate, or statistic. A sourced range beats a confident number you made up.
- Every figure carries its geography, period, units and source. A number without those is unusable and worse than none.
- Distinguish the total market from the reachable market from the media-reachable audience. Conflating them is the most common and most expensive error in this work.
- Where a figure genuinely is not publicly available, say so and say what would be needed to establish it. That is a useful finding, not a failure.

BE DECISIVE WHERE THE QUESTION DEMANDS IT:
- The supply-versus-demand constraint question has an answer. Give it, with your reasoning, rather than presenting both sides evenly. A strategist cannot act on "it depends".
- The share-needed calculation should be arithmetic a human can check: state the reachable market, the client's target revenue, the average transaction value you are assuming, and therefore the share required.`,

  buildPrompt: ({ context, input, sectionBrief, submitToolName }) => {
    const geography = typeof input.geography === "string" ? input.geography.trim() : "";
    return `Research the market for this business.

BUSINESS CONTEXT
${renderContext(context)}
${geography ? `\nGEOGRAPHY\nFocus on: ${geography}` : ""}

SECTIONS TO PRODUCE — each section's description is the question it must answer
${sectionBrief}

Call ${submitToolName} once when you are done.`;
  },

  describeStart: (input) =>
    typeof input.geography === "string" && input.geography.trim()
      ? `Researching the market in ${input.geography.trim()}.`
      : "Researching the market.",
});
