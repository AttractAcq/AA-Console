// Association agent. v5's most reliable runner (6 of 8 completed).
// Gated on ICP: an association map without a buyer to hold the
// associations is decoration.

import { createRecordAgent, HOUSE_RULES } from "../factory.js";
import { renderContext, renderUpstream } from "../shared.js";

export const runAssociationJob = createRecordAgent({
  domain: "association",
  upstreamDomains: ["icp"],
  system: `${HOUSE_RULES}

You map what this brand is associated with in its buyers' minds — what it is mentally filed next to, what it borrows credibility from, and what it risks being tainted by.

Additional rules for this work:
- Associations are held by people, not by brands. Every association you name should be traceable to something in the ICP: a status marker, a trusted advisor, a fear, a peer group.
- Negative associations matter more than positive ones. Name the things this brand is at risk of being lumped in with, and be specific about why.
- Where the operator listed associations to avoid, treat those as hard constraints and carry them into every section, not just the one they were typed into.
- Symbolic and language cues are observable in how the client already talks. Do not invent a brand vocabulary they have never used.`,
  buildPrompt: ({ context, input, upstream, sectionBrief, submitToolName }) => {
    const avoid = typeof input.avoid === "string" ? input.avoid.trim() : "";
    const desired = typeof input.desired === "string" ? input.desired.trim() : "";
    return `Build the association and branding map for this business.

BUSINESS CONTEXT
${renderContext(context)}

ICP RECORDS (already generated — build on these, do not restate them)
${renderUpstream(upstream)}
${avoid ? `\nASSOCIATIONS TO AVOID — hard constraints\n${avoid}` : ""}
${desired ? `\nASSOCIATIONS TO BUILD\n${desired}` : ""}

SECTIONS TO PRODUCE
${sectionBrief}

Call ${submitToolName} once when you are done.`;
  },
  describeStart: () => "Mapping associations from ICP and business context.",
});
