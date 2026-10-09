/**
 * The brief AA receives from the landing page's audit form.
 *
 * Its own module rather than a second export from the component, so the
 * composition can be tested without rendering and the component file stays
 * fast-refreshable.
 */

export type AuditAnswers = {
  business: string;
  service: string;
  website: string;
  goal: string;
};

export const AUDIT_EMAIL = "hello@attractacq.com";

export function auditBrief(answers: AuditAnswers): { subject: string; body: string } {
  const business = answers.business.trim() || "Unnamed business";
  const lines = [
    `Business: ${business}`,
    `Main service: ${answers.service.trim() || "—"}`,
    `Website: ${answers.website.trim() || "—"}`,
    "",
    "What we want fixed:",
    answers.goal.trim() || "—",
  ];
  return { subject: `Proof audit request — ${business}`, body: lines.join("\n") };
}

export function auditMailto(answers: AuditAnswers): string {
  const { subject, body } = auditBrief(answers);
  return `mailto:${AUDIT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
