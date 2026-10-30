/** Exact invitation source contract consumed by the B008 global Inbox. */
export interface InvitationInboxCard {
  id: string;
  client_id: string | null;
  source_system: string;
  source_kind: string;
  source_id: string;
  source_version: string;
  status: string;
  expires_at: string | null;
  artifact_hash: string | null;
  preview: unknown;
  destination: string | null;
  account_ref: string | null;
  scope: unknown;
  owner_role: string | null;
  preview_blocker: string | null;
}

const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CATEGORY = new Set(["avatars", "editors", "smm", "creative_director"]);

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Null only when every field needed to decide one exact email is present. */
export function invitationApprovalBlocker(card: InvitationInboxCard): string | null {
  if (card.source_system !== "auth" || card.source_kind !== "console_invitation"
    || card.owner_role !== "admin"
    || !UUID.test(card.source_id)) return "This is not an agency Auth invitation card.";
  if (card.preview_blocker?.trim()) return card.preview_blocker;
  if (!HASH.test(card.source_version) || card.source_version !== card.artifact_hash) {
    return "The frozen invitation hash is incomplete or changed.";
  }
  if (!card.expires_at || !Number.isFinite(Date.parse(card.expires_at))) {
    return "The invitation expiry is missing.";
  }
  const preview = object(card.preview);
  const scope = object(card.scope);
  if (!preview || !scope) return "The exact invitation preview or target scope is missing.";
  const email = preview.recipient_email;
  const sender = preview.sender_account;
  if (typeof email !== "string" || !EMAIL.test(email) || email !== email.toLowerCase()
    || card.destination !== email || typeof sender !== "string" || !EMAIL.test(sender)
    || sender !== sender.toLowerCase() || card.account_ref !== sender) {
    return "The recipient or sender does not match the frozen destination.";
  }
  const origin = preview.redirect_origin;
  if (typeof origin !== "string" || !/^https:\/\/[^/]+$/.test(origin)
    || preview.redirect_url !== `${origin}/invite/accept?request=${card.source_id}`) {
    return "The invitation redirect does not match the frozen link.";
  }
  if (typeof preview.auth_project_origin !== "string"
    || !/^https:\/\/[^/]+$/.test(preview.auth_project_origin)
    || typeof preview.sender_verification_id !== "string"
    || !UUID.test(preview.sender_verification_id)
    || typeof preview.smtp_evidence_sha256 !== "string"
    || !HASH.test(preview.smtp_evidence_sha256)
    || typeof preview.template_subject !== "string"
    || !preview.template_subject.trim()
    || typeof preview.template_body !== "string"
    || !preview.template_body.trim()
    || typeof preview.template_sha256 !== "string"
    || !HASH.test(preview.template_sha256)) {
    return "The Auth sender or exact email template evidence is incomplete.";
  }
  if (typeof preview.full_name !== "string" || !preview.full_name.trim()
    || !Number.isFinite(Date.parse(String(preview.expires_at)))
    || Date.parse(String(preview.expires_at)) !== Date.parse(card.expires_at)) {
    return "The target name or expiry does not match the frozen preview.";
  }
  if (preview.target_role !== scope.target_role) return "The target role changed.";
  if (preview.target_role === "employee") {
    if (card.client_id !== null
      || typeof preview.target_member_id !== "string" || !UUID.test(preview.target_member_id)
      || preview.target_member_id !== scope.target_member_id
      || preview.target_client_id !== null || scope.target_client_id !== null
      || !CATEGORY.has(String(preview.team_category))
      || typeof preview.team_member_generation !== "number"
      || !Number.isSafeInteger(preview.team_member_generation)
      || Number(preview.team_member_generation) < 0) {
      return "The employee roster target is incomplete.";
    }
  } else if (preview.target_role === "client") {
    if (typeof preview.target_client_id !== "string" || !UUID.test(preview.target_client_id)
      || card.client_id !== preview.target_client_id
      || preview.target_client_id !== scope.target_client_id
      || preview.target_member_id !== null || scope.target_member_id !== null
      || preview.team_category !== null) {
      return "The client target is incomplete.";
    }
  } else return "The invitation role is unsupported.";
  return null;
}

export function invitationCanApprove(card: InvitationInboxCard): boolean {
  return card.status === "pending" && invitationApprovalBlocker(card) === null
    && Date.parse(card.expires_at!) > Date.now();
}

export function invitationCanReject(card: InvitationInboxCard): boolean {
  return (card.status === "pending" || card.status === "expired")
    && invitationApprovalBlocker(card) === null;
}
