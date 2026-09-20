// Two more asks, the same shape.
//
// A sales agent is built from a purpose; a page is built from "what this page
// is for". Both are a paragraph the operator writes before an agent that will
// then read the offer strategy, the ICP, the brand voice and the proof for
// itself. So the paragraph does not need to repeat any of that — it needs to
// say the thing the records cannot: which surface, which moment, what this
// particular one is doing that the others are not.
//
// One module because the two differ only in what they are briefing. A sales
// agent brief that reads like a page brief is wrong in a specific way, and
// that is a prompt difference, not a validation difference.

export type BriefKind = "sales_agent" | "page";

export interface GeneratedAsk {
  ask: string;
}

const MIN_ASK = 80;

/**
 * A runaway bound, not a style rule.
 *
 * This was 1500, and it binned a page brief at 2342 characters — the third
 * time in this feature that a length I picked by intuition destroyed a whole
 * paid run. The same generator's sales brief passed at a similar size, which
 * is what a borderline number looks like from the inside.
 *
 * The lesson is narrower than "the number was wrong". Length is TASTE, and
 * taste belongs in the prompt, which already says this is a brief and not the
 * thing itself. Validation is for correctness — an invented price, a
 * placeholder, marketing register in place of content — where being wrong
 * makes the output unusable rather than merely long.
 */
const MAX_ASK = 6000;

const PLACEHOLDER = /\[[^\]]{2,}\]|\{\{[^}]+\}\}/;

/** Money, which neither brief has any business fixing. */
const MONEY = /(?:\b(?:ZAR|R)\s?|[$£€]\s?)\d[\d,.\s]*(?:k\b|m\b|million|thousand)?/i;

/**
 * Restating the strategy instead of briefing against it.
 *
 * The failure mode for both of these is a paragraph that sounds thorough and
 * says nothing the downstream agent did not already have: "leveraging our
 * unique value proposition to engage our ideal customer profile". The agent
 * reads the real offer strategy and the real ICP. It needs what is NOT there.
 */
const EMPTY_MARKETING =
  /\b(?:leverag\w+|synerg\w+|unique value proposition|best[- ]in[- ]class|world[- ]class|cutting[- ]edge|holistic approach|seamless(?:ly)? (?:integrat\w+|experience))\b/i;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Why this ask should not be handed to the agent that will build from it. */
export function askProblem(draft: Record<string, unknown>, kind: BriefKind): string | null {
  const ask = text(draft.ask);
  const subject = kind === "sales_agent" ? "agent" : "page";

  if (!ask) return `The draft says nothing about what the ${subject} is for.`;
  if (ask.length < MIN_ASK) {
    return `The ask is too thin to build a ${subject} from. Say what it is doing that nothing else is.`;
  }
  if (ask.length > MAX_ASK) {
    return `The ask is ${ask.length} characters, past the ${MAX_ASK} limit. Something has run away.`;
  }
  if (PLACEHOLDER.test(ask)) {
    return "The ask contains a placeholder. Write the real words or leave the detail out.";
  }
  if (MONEY.test(ask)) {
    return "The ask names a figure. Nothing here knows what this client charges, and a number in the brief becomes a promise in the output.";
  }
  if (EMPTY_MARKETING.test(ask)) {
    // The agent already reads the offer strategy and the ICP. Restating them
    // in marketing register is length without information.
    return `The ask is written in marketing register rather than saying anything. The ${subject} agent already reads the offer strategy, the ICP and the brand voice — tell it what those do not contain.`;
  }

  return null;
}

export function normaliseAsk(draft: Record<string, unknown>): GeneratedAsk {
  return { ask: text(draft.ask) };
}
