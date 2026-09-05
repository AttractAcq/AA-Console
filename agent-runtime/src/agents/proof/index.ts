// Proof Intelligence.
//
// Distinct from the Proof Bank: the Bank stores proof assets, this
// assesses what proof the business has, what makes it genuinely unique,
// and what its daily work could be turned into.
//
// No web search — this is about THIS business, and the material is what
// the client told us plus whatever proof is already on file. Searching
// would invite exactly the invented-credential failure that makes proof
// worthless.

import { createRecordAgent, HOUSE_RULES } from "../factory.js";
import { renderContext, renderUpstream } from "../shared.js";

export const runProofJob = createRecordAgent({
  domain: "proof",
  upstreamDomains: ["icp"],

  system: `${HOUSE_RULES}

You assess this business's proof: what it has, what makes it unique, and what it could capture.

Additional rules for this work:
- Proof is evidence, not a claim. "We have 20 years of experience" is a claim; the specific case that could only come from 20 years is proof.
- Only reference proof that actually exists in what you were given. Where the business has none of a given kind, say so plainly and move to what they COULD capture — a gap honestly named is more useful than a fabricated credential, and a fabricated one is a liability.
- The daily-work section must be practical. Name things someone could film or photograph this week with a phone, not a production plan.
- Proof of work and proof of concept are different and both matter. Work shows they do the thing well; concept shows the approach produces the outcome. Do not blur them.
- Aim proof at the ICP's actual objections and fears. Proof that answers nothing anyone was worried about is decoration.`,

  buildPrompt: ({ context, upstream, sectionBrief, submitToolName }) => `Assess the proof position for this business.

BUSINESS CONTEXT
${renderContext(context)}

ICP — aim the proof at this buyer's objections, fears and decision criteria
${renderUpstream(upstream)}

SECTIONS TO PRODUCE — each section's description is the question it must answer
${sectionBrief}

Call ${submitToolName} once when you are done.`,

  describeStart: () => "Assessing proof position against the ICP.",
});
