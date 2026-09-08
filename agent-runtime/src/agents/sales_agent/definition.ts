// What a built sales agent has to contain to be worth deploying, and the
// coercion that gets model output into the shape the table stores.
//
// These live here rather than inline in the job for the reason four earlier
// tools taught the hard way: a rule written inline in a job function can be
// deleted without a single test failing. Everything below is a rule about what
// may be put in front of a client's own customers, which is the last place to
// keep an untested check.

export interface QualificationStep {
  question: string;
  why: string;
  good_answer: string;
  disqualifier: string;
}

export interface Objection {
  objection: string;
  response: string;
}

export interface SalesAgentDefinition {
  greeting: string;
  system_prompt: string;
  qualification: QualificationStep[];
  objections: Objection[];
  booking_rule: string;
  escalation_rule: string;
  guardrails: string;
}

/** The fewest questions that can actually qualify anyone. */
export const MIN_QUALIFICATION = 3;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Model output into stored shape, dropping what cannot be used.
 *
 * A qualification step with no question is not a step — keeping it would put
 * a blank prompt in front of a visitor. A step missing only its reasoning is
 * kept, because the question still works; the reasoning is for whoever reviews
 * the agent later.
 */
export function normaliseQualification(raw: unknown): QualificationStep[] {
  if (!Array.isArray(raw)) return [];
  const out: QualificationStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const question = str(row.question);
    if (!question) continue;
    out.push({
      question,
      why: str(row.why),
      good_answer: str(row.good_answer),
      disqualifier: str(row.disqualifier),
    });
  }
  return out;
}

/** Same treatment for objections: an objection with no answer is not handled. */
export function normaliseObjections(raw: unknown): Objection[] {
  if (!Array.isArray(raw)) return [];
  const out: Objection[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const objection = str(row.objection);
    const response = str(row.response);
    if (!objection || !response) continue;
    out.push({ objection, response });
  }
  return out;
}

/**
 * A placeholder the model left behind — "[CLIENT NAME]", "[X]", "{{name}}".
 *
 * The identity block already bans naming a person the client has not named.
 * This is the other half of the same failure: a bracket the writer meant to
 * come back to, shipped to a visitor. It reads as broken software to the one
 * audience that must not see broken software.
 */
export function placeholderIn(text: string): string | null {
  const bracket = text.match(/\[[A-Za-z][^\]\n]{0,60}\]/);
  if (bracket) return bracket[0];
  const brace = text.match(/\{\{[^}\n]{0,60}\}\}/);
  if (brace) return brace[0];
  return null;
}

/**
 * Why this agent cannot be accepted, or null if it can.
 *
 * Each rule is here because the agent is missing something a visitor would hit
 * within the first minute of talking to it.
 */
export function definitionProblem(def: SalesAgentDefinition): string | null {
  if (!def.greeting) return "The agent came back with no opening line.";
  if (def.system_prompt.length < 400) {
    return "The agent came back with operating instructions too thin to run on.";
  }
  if (def.qualification.length < MIN_QUALIFICATION) {
    return `The agent came back with ${def.qualification.length} qualification question${
      def.qualification.length === 1 ? "" : "s"
    }. Fewer than ${MIN_QUALIFICATION} cannot separate a buyer from a browser.`;
  }
  if (!def.booking_rule) {
    return "The agent came back with no booking rule, so it has no idea when to ask for the appointment.";
  }
  // An agent with no exit condition talks through the one conversation that
  // needed a person — a complaint, a clinical question, a deal too big to
  // leave to a script.
  if (!def.escalation_rule) {
    return "The agent came back with no escalation rule, so it would keep talking through a conversation that needed a person.";
  }
  if (!def.guardrails) {
    return "The agent came back with no guardrails. It must be told what it may never promise before it speaks to anyone.";
  }

  const surfaces = [def.greeting, ...def.qualification.map((q) => q.question), ...def.objections.map((o) => o.response)];
  for (const surface of surfaces) {
    const found = placeholderIn(surface);
    if (found) {
      return `The agent came back with an unfilled placeholder a visitor would see: ${found}`;
    }
  }
  return null;
}

/** The readable summary stored alongside the structure, so it is legible without expanding anything. */
export function definitionSummary(def: SalesAgentDefinition): string {
  return [
    `**Opens with:** ${def.greeting}`,
    "",
    `**Qualifies on ${def.qualification.length} question${def.qualification.length === 1 ? "" : "s"}:**`,
    ...def.qualification.map((q, i) => `${i + 1}. ${q.question}`),
    "",
    `**Books when:** ${def.booking_rule}`,
    `**Hands over when:** ${def.escalation_rule}`,
  ].join("\n");
}
