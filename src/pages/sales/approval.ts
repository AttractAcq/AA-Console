// The copy a person reads before asking for exact-script public-use review.
//
// Approval is a source-owned AAL2 decision in Approval Inbox. Being live is
// an intention; this copy never writes a signature itself.

export type ApprovalScript = {
  name: string;
  greeting: string | null;
  qualification: Array<{ question: string }> | null;
  objections: Array<{ objection: string }> | null;
  guardrails: string | null;
};

/**
 * The request body. A short reading helps the requester identify the agent;
 * the Inbox shows the full immutable script before the reviewer decides.
 */
export function approvalConfirmBody(agent: ApprovalScript): string {
  const greeting = agent.greeting?.trim() || "(none written)";
  const questions = agent.qualification ?? [];
  const objections = agent.objections ?? [];
  const firstQuestion = questions[0]?.question?.trim();
  const firstObjection = objections[0]?.objection?.trim();
  const guardrails = agent.guardrails?.trim() || "(none written)";

  const qualification =
    questions.length === 0
      ? "Asks no qualification questions."
      : `Asks ${questions.length} qualification question${questions.length === 1 ? "" : "s"}${
          firstQuestion ? `, starting with: ${firstQuestion}` : "."
        }`;

  const objection =
    objections.length === 0
      ? "Handles no objections."
      : `Handles ${objections.length} objection${objections.length === 1 ? "" : "s"}${
          firstObjection ? `: ${firstObjection}` : "."
        }`;

  return [
    `Request public-use review for “${agent.name}”? The Approval Inbox will show its complete script for an AAL2 decision.`,
    `Opens with: ${greeting}`,
    endSentence(qualification),
    endSentence(objection),
    `Never says: ${guardrails}`,
  ].join(" ");
}

function endSentence(s: string): string {
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

export function revokeConfirmBody(agent: { name: string; status: string }): string {
  return `Revoke public approval for “${agent.name}”? This does not change its status (${agent.status}). It cannot be attached to a public site until it is approved again.`;
}
