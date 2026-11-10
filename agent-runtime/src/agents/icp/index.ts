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
Treat this as the operator's account, not verbatim customer testimony. In particular, an ideal_customer field describes the business's intended buyer hypothesis; it is not observed customer research. Marketing plans and sales process fields describe intended actions, not measured buyer behavior.
${focus ? `\nFOCUS SEGMENT\nNarrow to this segment specifically: ${focus}` : ""}
${notes || unverifiedQuotes ? `\nCUSTOMER LANGUAGE NOTES\nThese may be paraphrased call notes or summaries. Use them to identify themes, but never quote or attribute their wording as exact customer speech.\n\n${[notes, unverifiedQuotes].filter(Boolean).join("\n\n")}` : ""}
${quotes && quoteSource && quoteDate ? `\nVERIFIED VERBATIM CUSTOMER QUOTES\nThe operator identified these as exact customer words with source context. Quote only the exact words supplied, preserve their attribution, and do not invent surrounding details.\nSource: ${quoteSource}\nDate: ${quoteDate}\nExact words:\n${quotes}` : ""}

SECTIONS TO PRODUCE
${sectionBrief}

Write each section in 60–120 words unless the supplied evidence genuinely requires more. Use three labelled parts in each section: "Source (field name and operator hypothesis)", "Unknown", and "Validate". The Source part may only paraphrase content explicitly present in the named Business Context or input field; do not add a plausible implication. The Unknown part must state missing facts without implying their absence. The Validate part gives one useful question or measurement without an invented sample-size threshold. A short, accurate answer is better than filling a template with plausible buyer details.

Call ${submitToolName} once when you are done.`;
}

export const ICP_SYSTEM = `${HOUSE_RULES}

You build the Ideal Customer Profile: a testable portrait of the intended buyer, grounded in what this specific business has told us. Do not imply that this portrait has been observed in customers unless the input includes actual customer evidence.

Additional rules for this work:
- Write about one identifiable buyer situation, not a demographic bracket. Ground it in the stated target segment and mark unobserved behavior as a hypothesis.
- Where the operator supplied verified verbatim customer quotes, quote and build on them. Real phrasing beats invented phrasing every time.
- Only the separately labelled VERIFIED VERBATIM CUSTOMER QUOTES input may be quoted as a customer's exact words. Business Context and CUSTOMER LANGUAGE NOTES are operator summaries; do not put their sentences in a buyer's mouth or describe them as "in their own words".
- Do not turn a target-segment assumption into an observed trait. For example, a note about school fees does not establish that a particular buyer has children or a spouse. Avoid invented household details, objects, crew sizes, job histories and first-person speech, even when they seem plausible.
- Do not state buying authority, media habits, daily schedule, neighborhoods, channel preference, conversion timing or campaign targeting as known without direct source evidence. In a section that asks for them, state what is unknown and the specific customer question or measurement that would establish it. Do not attach a precise number or location to an unsupported hypothesis.
- Do not prescribe a new buyer split, ad audience, channel mix, selling season or campaign treatment from an unverified inference. Propose a bounded test instead, and leave the decision open until evidence exists.
- Read negative evidence exactly: "no client results" does not mean "no clients"; "pre-revenue" does not mean no leads or no work. A dated launch plan is not proof of the business's current status. Do not expand any of these into broader claims.
- Business Context has a last-updated date when available. Describe revenue, launch, marketing and results status as of that source date, not as the present state; if the date is missing or old, mark the current state unknown. A planned launch date is not evidence that launch happened.
- Do not invent a precise lead-time, sales-cycle length, customer sample size or validation threshold (such as "two to four weeks" or "ten calls") unless the source supplies it. Suggest what to measure without promising that an arbitrary sample will settle the question.
- A named competitor is not evidence that the target buyer uses or has encountered it. An offer price and crew count do not establish buyer turnover, management layers, buying authority or affordability. Do not put these unsupported implications under "known" or "supplied".
- Examples of invalid leaps: "two crews means a foreman runs the other crew"; "the agency names a marketplace, so this buyer uses it"; "a 1 October launch was planned, so the agency launched". State the unknown instead.
- Other invalid leaps: "no client results" does not establish whether a client has run the loop; "burned by marketing" does not mean the prior spend produced nothing; a capture day or on-camera brand rep does not establish that the owner personally appears on camera. Do not turn these into objections or proof claims.
- Do not state an internal feeling, motivation or trust response as a fact about the buyer. If useful, mark it as a question to validate in customer interviews.
- The question universe contains candidate questions to validate across awareness, comparison and decision stages. Do not call them actual buyer questions or near-verbatim customer language without a sourced transcript.
- Separate three levels in every section: supplied business plan or target hypothesis, verified customer observation (if any), and inference to test. Label material inferences where they appear, not only in a later disclaimer.
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
