// What gets written when a person accepts or withdraws a sales agent for
// public use, and the copy they have to read first.
//
// Approval is a signature, not a status. Being live is an intention; being
// approved is a person having read what the agent will say. These helpers are
// pure so the panel cannot silently one-click the write, and so tests can pin
// the payload without rendering.

export type ApprovalScript = {
  name: string;
  greeting: string | null;
  qualification: Array<{ question: string }> | null;
  objections: Array<{ objection: string }> | null;
  guardrails: string | null;
};

/** The columns an approve writes. Deliberately omits `status`. */
export function approveFields(userId: string, now: Date = new Date()) {
  const at = now.toISOString();
  return {
    approved_at: at,
    approved_by: userId,
    updated_at: at,
  };
}

/** Clears the signature. Does not touch `status`. */
export function revokeFields(now: Date = new Date()) {
  return {
    approved_at: null,
    approved_by: null,
    updated_at: now.toISOString(),
  };
}

/**
 * The confirm body. Name, greeting, and a short reading of qualification,
 * objections and guardrails — the minimum a person should have in front of
 * them before they accept this agent speaking to the public.
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
    `Approve “${agent.name}” for public use? Read what it will say before you confirm.`,
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
