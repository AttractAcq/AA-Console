// Offer Strategy. The eleven templates are Hormozi's value equation plus
// guarantee, bonuses, scarcity and urgency — a prescriptive structure, so
// the risk here is filling the shape with generic copy rather than
// something this business could actually honour.

import { createRecordAgent, HOUSE_RULES } from "../factory.js";
import { renderContext, renderUpstream } from "../shared.js";

export const runOfferStrategyJob = createRecordAgent({
  domain: "offer_strategy",
  upstreamDomains: ["icp"],
  system: `${HOUSE_RULES}

You design the offer: how the client's existing service gets packaged so the value is obvious and the risk of buying feels small.

Additional rules for this work:
- Build on the offer they actually have. You are packaging and articulating, not inventing a new business.
- The value equation is four levers pulling against each other: raise the dream outcome and perceived likelihood, lower the time delay and effort. Each section should say something a competitor could not copy by changing a word.
- Anything in "cannot promise" is a hard limit. Never write a guarantee, bonus or claim that crosses it — an unhonourable guarantee is worse than no guarantee, and this is the section where that mistake gets published.
- Scarcity and urgency must be real and defensible: genuine capacity limits, real deadlines, actual cohort sizes. Manufactured urgency is both ineffective and, in regulated sectors, a liability.
- Bonuses should remove a specific obstacle the ICP actually has, not add unrelated value.`,
  buildPrompt: ({ context, input, upstream, sectionBrief, submitToolName }) => {
    const price = typeof input.price_point === "string" ? input.price_point.trim() : "";
    const constraints = typeof input.constraints === "string" ? input.constraints.trim() : "";
    return `Design the offer strategy for this business.

BUSINESS CONTEXT
${renderContext(context)}

ICP RECORDS — the offer must answer this buyer's actual objections and desired outcomes
${renderUpstream(upstream)}
${price ? `\nPRICE POINT\n${price}` : ""}
${constraints ? `\nCANNOT PROMISE — hard limits, never cross these\n${constraints}` : ""}

SECTIONS TO PRODUCE
${sectionBrief}

Call ${submitToolName} once when you are done.`;
  },
  describeStart: () => "Designing offer strategy from ICP and business context.",
});
