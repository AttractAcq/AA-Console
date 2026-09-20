// Proposing a campaign, from what the business already knows about itself.
//
// New Campaign asks for a name and a one-line ask, and the planner turns that
// into objective, audience, message, channels and a list of things to build.
// The gap is the step before: knowing what campaign is worth running at all.
// That answer is sitting in the client's own records — the offer strategy, the
// ICP, the money model, the competitor and market work — and nobody reads all
// of it before typing a campaign name.
//
// So this proposes one. Not the plan, which is the planner's job and already
// good at it: just the name and the ask, in the form's own two fields, so the
// operator can edit them and press the button they were going to press anyway.
//
// Notes are OPTIONAL here, unlike a hiring brief. An operator knows things
// about a role that are written down nowhere; the business's own strategy is
// already on file, so a blank box should still produce a real proposal.

export interface CampaignDraft {
  name: string;
  brief: string;
}

/**
 * Runaway bounds, not style rules.
 *
 * The brief was 2000. Nothing outside AA ever reads it, and a campaign ask
 * that runs long is a thing to edit rather than a thing to throw a paid run
 * away over — which is what a tight cap does, three times over in this
 * feature before the lesson stuck.
 *
 * Length is taste, and taste belongs in the prompt, which already asks for a
 * short paragraph. Validation is for correctness: an invented budget makes
 * the output unusable, a long paragraph does not.
 */
const LIMITS = { name: 200, brief: 8000 } as const;
const MIN_BRIEF = 60;

/** A bracketed gap somebody was supposed to fill in. */
const PLACEHOLDER = /\[[^\]]{2,}\]|\{\{[^}]+\}\}/;

/**
 * Money and dates the model has no basis for.
 *
 * The planner is told never to invent a budget, and it holds that line. It
 * cannot hold it against a brief that already contains one: a figure in the
 * ask reads as the operator's instruction, and the plan commits to it.
 */
// Letters and symbols need different boundaries: \b before "$" never matches,
// because a space and a "$" are both non-word characters. Requiring it meant
// only R and ZAR were ever caught.
const INVENTED_BUDGET = /(?:\b(?:ZAR|R)\s?|[$£€]\s?)\d[\d,.\s]*(?:k\b|m\b|million|thousand)?/i;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Why this proposal cannot be handed to the planner, or null. */
export function campaignDraftProblem(draft: Record<string, unknown>): string | null {
  const name = text(draft.name);
  const brief = text(draft.brief);

  if (!name) return "The proposal has no campaign name.";
  if (!brief) return "The proposal says nothing about what the campaign is for.";
  if (brief.length < MIN_BRIEF) {
    return "The ask is too thin for the planner to work from. Say what the campaign is trying to achieve and for whom.";
  }
  if (name.length > LIMITS.name) {
    return `The campaign name is ${name.length} characters, past the ${LIMITS.name} limit. Something has run away.`;
  }
  if (brief.length > LIMITS.brief) {
    return `The ask is ${brief.length} characters, past the ${LIMITS.brief} limit. Something has run away.`;
  }

  for (const [field, value] of [["name", name], ["brief", brief]] as const) {
    if (PLACEHOLDER.test(value)) {
      return `The ${field} contains a placeholder. Write the real words or leave the detail out.`;
    }
  }

  if (INVENTED_BUDGET.test(brief)) {
    return "The ask names a budget. Nothing here knows what the client will spend, and a figure in the ask becomes a commitment in the plan.";
  }

  return null;
}

/** The proposal, with only the two fields the form takes. */
export function normaliseCampaignDraft(draft: Record<string, unknown>): CampaignDraft {
  return { name: text(draft.name), brief: text(draft.brief) };
}
