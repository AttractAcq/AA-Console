// Competitor agent. The one agent form with a genuinely required input:
// the operator names who the competitors are, and everything the
// Competitors tab renders is what this produces.
//
// Web search is enabled here — competitor research without it would be
// the model recalling brands from training, which is exactly the failure
// mode the evidence rules exist to prevent.
//
// Prompt discipline ported from v5's Competitor OS, which completed 41
// production runs.

import { createRecordAgent } from "../factory.js";
import { renderContext } from "../shared.js";

interface Competitor {
  name: string;
  url?: string | null;
}

function readCompetitors(input: Record<string, unknown>): Competitor[] {
  const raw = input.competitors;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (typeof entry === "string") return { name: entry.trim() };
      const record = entry as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name.trim() : "";
      const url = typeof record.url === "string" ? record.url.trim() : null;
      return name ? { name, url } : null;
    })
    .filter((c): c is Competitor => c !== null);
}

export const runCompetitorJob = createRecordAgent({
  domain: "competitor",
  enableWebSearch: true,
  maxSearches: 15,

  // Non-retryable: no amount of retrying conjures a competitor list.
  validate: (input) =>
    readCompetitors(input).length === 0
      ? "No competitors were supplied. Open Competitor Inputs and name at least one competitor."
      : null,

  system: `You are the evidence-controlled competitor research agent for Attract Acquisition, a marketing agency.

You research a client's named competitors using public sources and produce structured observations for the agency's strategists.

EVIDENCE RULES — these are absolute:
- Use only public, lawfully accessible material. Never log in, bypass access controls, evade platform restrictions, impersonate anyone, or collect private or personal data.
- Paraphrase what you observe. Do not reproduce protected creative work or substantial competitor copy.
- Never invent sources, quotes, prices, performance figures, customers, or results. If something is not publicly observable, say that it is not observable rather than estimating it.
- Distinguish what you observed from what you infer. Mark inference as inference.
- Never describe a finding as verified. Verification is a separate human workflow.

SCOPE:
- Describe observations and patterns. Do not rank winners, recommend a response, prescribe positioning, or turn evidence into strategy — a different agent does that, and doing it here corrupts its input.
- Where evidence is thin, a short honest section is correct. Padding is not.

OUTPUT QUALITY:
- Never write placeholder, filler or stub text ("sample", "placeholder", "n/a", "none", "tbd", "not used") into any section, even under length pressure. A short real sentence is always correct where a placeholder token is never correct.
- If you are running low on output budget, shorten your wording rather than degrading any section.

When you have finished researching, call submit_analysis exactly once with your final structured output. Do not call it before you are done.`,

  buildPrompt: ({ context, input, sectionBrief, submitToolName }) => {
    const competitors = readCompetitors(input);
    const competitorList = competitors
      .map((c, i) => `${i + 1}. ${c.name}${c.url ? ` — ${c.url}` : ""}`)
      .join("\n");
    return `Research these competitors for the client described below.

COMPETITORS TO RESEARCH
${competitorList}

CLIENT CONTEXT
${renderContext(context)}

SECTIONS TO PRODUCE
${sectionBrief}

Research each competitor's public presence, then write each section across the whole competitive set rather than one competitor at a time. Where competitors differ meaningfully, name which competitor a given observation belongs to.

Call ${submitToolName} once when you are done.`;
  },

  describeStart: (input) => {
    const names = readCompetitors(input).map((c) => c.name);
    return `Researching ${names.length} competitor${names.length === 1 ? "" : "s"}: ${names.join(", ")}.`;
  },
});
