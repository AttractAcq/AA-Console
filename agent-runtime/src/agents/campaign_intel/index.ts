// Campaign Intelligence. The one domain whose records carry a period —
// four quarters per year, unique on (client, domain, item_key, period).

import { createRecordAgent, HOUSE_RULES } from "../factory.js";
import { renderContext } from "../shared.js";

function resolveYear(input: Record<string, unknown>): string {
  const raw = input.year;
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 2000 ? String(parsed) : String(new Date().getFullYear());
}

export const runCampaignIntelJob = createRecordAgent({
  domain: "campaign_intel",
  system: `${HOUSE_RULES}

You plan a year of campaign timing: what this business should be saying in each quarter, and why that quarter rather than another.

Additional rules for this work:
- Anchor every quarter to something real — the client's own busy and quiet periods, their sales cycle, industry or regional seasonality, or dates the operator supplied. A quarter plan with no anchor is a guess dressed as a plan.
- The operator's known dates outrank anything you infer. If they say the business closes for two weeks in July, Q3 must reflect that.
- Say what makes each quarter different from the others. Four interchangeable quarters mean you have not actually planned anything.
- Be explicit about which hemisphere and market you are reasoning about when seasonality matters.`,
  buildPrompt: ({ context, input, sectionBrief, submitToolName }) => {
    const keyDates = typeof input.key_dates === "string" ? input.key_dates.trim() : "";
    return `Plan campaign intelligence for ${resolveYear(input)}.

BUSINESS CONTEXT
${renderContext(context)}
${keyDates ? `\nKNOWN DATES — supplied by the operator, these outrank anything you infer\n${keyDates}` : ""}

SECTIONS TO PRODUCE (one per quarter)
${sectionBrief}

Call ${submitToolName} once when you are done.`;
  },
  resolvePeriod: resolveYear,
  describeStart: (input) => `Planning campaign intelligence for ${resolveYear(input)}.`,
});
