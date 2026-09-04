// ICP agent. Ported from v5's Avatar OS, whose 15 modules are exactly this
// domain's record_templates — including the question universe, which
// Ideation later consumes rather than rebuilding.
//
// No web search: this is synthesis from what the client told us plus any
// real customer language the operator pasted in. Searching the web for a
// client's own buyers would produce generic persona filler, which is the
// failure mode this agent exists to avoid.

import { createRecordAgent, HOUSE_RULES } from "../factory.js";
import { renderContext } from "../shared.js";

export const runIcpJob = createRecordAgent({
  domain: "icp",
  system: `${HOUSE_RULES}

You build the Ideal Customer Profile: a portrait of who actually buys, grounded in what this specific business has told us.

Additional rules for this work:
- Write about one identifiable buyer, not a demographic bracket. "Women 35-54" is not an ICP; "a practice owner who has just lost their second associate and is doing clinical work they hired someone else to do" is.
- Where the operator supplied real customer language, quote and build on it. Real phrasing beats invented phrasing every time.
- The question universe is not a list of FAQs. It is what this buyer is actually asking — of themselves, of peers, of search engines — across becoming aware, weighing options, and justifying the decision.
- If the business context is thin, say what you cannot yet know rather than filling the gap with a plausible-sounding stereotype.`,
  buildPrompt: ({ context, input, sectionBrief, submitToolName }) => {
    const focus = typeof input.focus_segment === "string" ? input.focus_segment.trim() : "";
    const voice = typeof input.voice_of_customer === "string" ? input.voice_of_customer.trim() : "";
    return `Build the ICP for this business.

BUSINESS CONTEXT
${renderContext(context)}
${focus ? `\nFOCUS SEGMENT\nNarrow to this segment specifically: ${focus}` : ""}
${voice ? `\nREAL CUSTOMER LANGUAGE\nThe operator supplied this verbatim. Use it — quote it where it earns a place, and let it shape how you describe language patterns, objections and questions.\n\n${voice}` : ""}

SECTIONS TO PRODUCE
${sectionBrief}

Call ${submitToolName} once when you are done.`;
  },
  describeStart: (input) =>
    typeof input.focus_segment === "string" && input.focus_segment.trim()
      ? `Building ICP, focused on: ${input.focus_segment.trim()}.`
      : "Building ICP from business context.",
});
