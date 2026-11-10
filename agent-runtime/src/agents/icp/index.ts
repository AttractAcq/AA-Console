// ICP agent. Ported from v5's Avatar OS, whose 15 modules are exactly this
// domain's record_templates — including the question universe, which
// Ideation later consumes rather than rebuilding.
//
// No web search: this is synthesis from what the client told us plus any
// real customer language the operator pasted in. Searching the web for a
// client's own buyers would produce generic persona filler, which is the
// failure mode this agent exists to avoid.

import { createRecordAgent, HOUSE_RULES, type PromptArgs } from "../factory.js";
import { renderContext } from "../shared.js";

export function buildIcpPrompt({ context, input, sectionBrief, submitToolName }: PromptArgs): string {
  const focus = typeof input.focus_segment === "string" ? input.focus_segment.trim() : "";
  const notes = typeof input.voice_of_customer === "string" ? input.voice_of_customer.trim() : "";
  const quotes = typeof input.verified_customer_quotes === "string" ? input.verified_customer_quotes.trim() : "";
  const quoteSource = typeof input.verified_quote_source === "string" ? input.verified_quote_source.trim() : "";
  const quoteDate = typeof input.verified_quote_date === "string" ? input.verified_quote_date.trim() : "";
  const unverifiedQuotes = quotes && (!quoteSource || !quoteDate) ? quotes : "";
  return `Build the ICP for this business.

BUSINESS CONTEXT
${renderContext(context)}
Treat this as the operator's account, not verbatim customer testimony.
${focus ? `\nFOCUS SEGMENT\nNarrow to this segment specifically: ${focus}` : ""}
${notes || unverifiedQuotes ? `\nCUSTOMER LANGUAGE NOTES\nThese may be paraphrased call notes or summaries. Use them to identify themes, but never quote or attribute their wording as exact customer speech.\n\n${[notes, unverifiedQuotes].filter(Boolean).join("\n\n")}` : ""}
${quotes && quoteSource && quoteDate ? `\nVERIFIED VERBATIM CUSTOMER QUOTES\nThe operator identified these as exact customer words with source context. Quote only the exact words supplied, preserve their attribution, and do not invent surrounding details.\nSource: ${quoteSource}\nDate: ${quoteDate}\nExact words:\n${quotes}` : ""}

SECTIONS TO PRODUCE
${sectionBrief}

Call ${submitToolName} once when you are done.`;
}

export const ICP_SYSTEM = `${HOUSE_RULES}

You build the Ideal Customer Profile: a portrait of who actually buys, grounded in what this specific business has told us.

Additional rules for this work:
- Write about one identifiable buyer, not a demographic bracket. "Women 35-54" is not an ICP; "a practice owner who has just lost their second associate and is doing clinical work they hired someone else to do" is.
- Where the operator supplied verified verbatim customer quotes, quote and build on them. Real phrasing beats invented phrasing every time.
- Only the separately labelled VERIFIED VERBATIM CUSTOMER QUOTES input may be quoted as a customer's exact words. Business Context and CUSTOMER LANGUAGE NOTES are operator summaries; do not put their sentences in a buyer's mouth or describe them as "in their own words".
- Do not invent household details, objects, crew sizes, job histories or first-person speech to make the portrait vivid. If a plausible situation is useful but unverified, label it as a hypothesis.
- The question universe is not a list of FAQs. It is what this buyer is actually asking — of themselves, of peers, of search engines — across becoming aware, weighing options, and justifying the decision.
- If the business context is thin, say what you cannot yet know rather than filling the gap with a plausible-sounding stereotype.`;

export const runIcpJob = createRecordAgent({
  domain: "icp",
  system: ICP_SYSTEM,
  buildPrompt: buildIcpPrompt,
  describeStart: (input) =>
    typeof input.focus_segment === "string" && input.focus_segment.trim()
      ? `Building ICP, focused on: ${input.focus_segment.trim()}.`
      : "Building ICP from business context.",
});
