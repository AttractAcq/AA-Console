// Brand Strategy — the cross-OS synthesis. Gated on ICP, Competitor and
// Association, which is not a formality: "Cross-OS Synthesis" is literally
// what the first template asks for, and without those three there is
// nothing to synthesise.
//
// This is the first agent whose output is client-facing strategy rather
// than observation, so the editable-by-a-human path matters most here.

import { createRecordAgent, HOUSE_RULES } from "../factory.js";
import { renderContext, renderUpstream } from "../shared.js";

export const runBrandStrategyJob = createRecordAgent({
  domain: "brand_strategy",
  upstreamDomains: ["icp", "competitor", "association"],
  system: `${HOUSE_RULES}

You synthesise the intelligence gathered so far into brand strategy. This is where observation becomes a recommendation, and you are the first agent permitted to make one.

Additional rules for this work:
- Synthesis means finding what the three intelligence sets say *together* that none says alone. Restating them in a different order is not synthesis.
- Every recommendation must trace to specific evidence in the records you were given. Name the evidence. A recommendation a strategist cannot audit is worse than none.
- Where the evidence is contradictory or thin, say so and recommend accordingly — a hedged recommendation grounded in real gaps beats a confident one built on nothing.
- Recommend a portfolio the client could actually execute given their stated size and resources. Strategy they cannot run is not strategy.`,
  buildPrompt: ({ context, input, upstream, sectionBrief, submitToolName }) => {
    const constraint = typeof input.constraint === "string" ? input.constraint.trim() : "";
    return `Produce the brand strategy for this business.

BUSINESS CONTEXT
${renderContext(context)}

INTELLIGENCE RECORDS — synthesise across all three sets
${renderUpstream(upstream)}
${constraint ? `\nSTRATEGIC CONSTRAINT — the strategy must work around this\n${constraint}` : ""}

SECTIONS TO PRODUCE
${sectionBrief}

Call ${submitToolName} once when you are done.`;
  },
  describeStart: () => "Synthesising brand strategy from ICP, competitor and association records.",
});
