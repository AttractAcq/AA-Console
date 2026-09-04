// Money Model. Gated on Offer Strategy — the four offer types are
// positions around a core offer, so without that offer there is nothing
// to arrange them around.

import { createRecordAgent, HOUSE_RULES } from "../factory.js";
import { renderContext, renderUpstream } from "../shared.js";

const MODEL_PREFERENCE: Record<string, string> = {
  subscription: "The client prefers a subscription/recurring model.",
  one_off: "The client prefers one-off purchases rather than recurring billing.",
  hybrid: "The client prefers a hybrid of recurring and one-off revenue.",
  agent: "No preference stated — recommend the model the evidence supports.",
};

export const runMoneyModelJob = createRecordAgent({
  domain: "money_model",
  upstreamDomains: ["offer_strategy", "icp"],
  system: `${HOUSE_RULES}

You design the money model: how attraction, continuity, upsell and downsell offers fit around the core offer so the business acquires customers profitably and keeps them.

Additional rules for this work:
- Each of the four offers must have a job. Say what the attraction offer is attracting, what the continuity offer is retaining, what the upsell escalates and what the downsell rescues.
- The attraction offer must be something this buyer would plausibly say yes to before trusting the business. If it requires trust the business has not earned yet, it is not an attraction offer.
- The downsell exists to catch a specific objection from the ICP. Name that objection.
- Respect the client's stated revenue position and preference. Recommending a subscription model to a business whose buyers purchase once in a decade is a failure, however elegant.
- Be concrete about sequence and price relationship between the four, not just their names.`,
  buildPrompt: ({ context, input, upstream, sectionBrief, submitToolName }) => {
    const preference = typeof input.model_preference === "string" ? input.model_preference : "";
    const note = MODEL_PREFERENCE[preference];
    return `Design the money model for this business.

BUSINESS CONTEXT
${renderContext(context)}

OFFER STRATEGY AND ICP RECORDS — arrange the money model around this offer and this buyer
${renderUpstream(upstream)}
${note ? `\nMODEL PREFERENCE\n${note}` : ""}

SECTIONS TO PRODUCE
${sectionBrief}

Call ${submitToolName} once when you are done.`;
  },
  describeStart: () => "Designing money model from offer strategy and ICP.",
});
