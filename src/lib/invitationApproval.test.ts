import { describe, expect, it } from "vitest";
import { invitationApprovalBlocker, invitationCanApprove, invitationCanReject,
  type InvitationInboxCard } from "./invitationApproval";

const ID = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";
const CLIENT = "55555555-5555-4555-8555-555555555555";
const HASH = "a".repeat(64);
const EXPIRY = "2035-01-01T00:00:00Z";
const card: InvitationInboxCard = {
  id: "33333333-3333-4333-8333-333333333333", client_id: null,
  source_system: "auth", source_kind: "console_invitation",
  source_id: ID, source_version: HASH, status: "pending", expires_at: EXPIRY,
  artifact_hash: HASH, destination: "new@example.com", account_ref: "auth@attractacq.com",
  owner_role: "admin", preview_blocker: null,
  preview: {
    recipient_email: "new@example.com", sender_account: "auth@attractacq.com",
    target_role: "employee", target_member_id: MEMBER, target_client_id: null,
    team_category: "editors", team_member_generation: 0, full_name: "New Editor",
    redirect_origin: "https://console.attractacq.com",
    redirect_url: `https://console.attractacq.com/invite/accept?request=${ID}`,
    auth_project_origin: "https://project.supabase.co",
    sender_verification_id: "44444444-4444-4444-8444-444444444444",
    smtp_evidence_sha256: "b".repeat(64),
    template_subject: "Your AA Console invitation",
    template_body: "Use the invitation link to join.",
    template_sha256: "c".repeat(64),
    expires_at: EXPIRY,
  },
  scope: { target_role: "employee", target_member_id: MEMBER, target_client_id: null },
};

describe("one-recipient invitation Inbox readiness", () => {
  it("allows a complete exact-version card", () => {
    expect(invitationApprovalBlocker(card)).toBeNull();
    expect(invitationCanApprove(card)).toBe(true);
    expect(invitationCanReject(card)).toBe(true);
  });

  it("allows a creative director roster invitation", () => {
    const directorCard: InvitationInboxCard = {
      ...card,
      preview: { ...card.preview as object, team_category: "creative_director" },
    };
    expect(invitationApprovalBlocker(directorCard)).toBeNull();
    expect(invitationCanApprove(directorCard)).toBe(true);
  });

  it("allows a client card only in the exact client scope", () => {
    const clientCard: InvitationInboxCard = {
      ...card, client_id: CLIENT,
      preview: { ...card.preview as object, target_role: "client",
        target_member_id: null, target_client_id: CLIENT,
        team_category: null, team_member_generation: null },
      scope: { target_role: "client", target_member_id: null, target_client_id: CLIENT },
    };
    expect(invitationApprovalBlocker(clientCard)).toBeNull();
    expect(invitationCanApprove(clientCard)).toBe(true);
    expect(invitationApprovalBlocker({ ...clientCard, client_id: null })).not.toBeNull();
    expect(invitationApprovalBlocker({ ...clientCard, client_id: MEMBER })).not.toBeNull();
  });

  it.each([
    ["preview blocker", { preview_blocker: "Sender not verified" }],
    ["client scope", { client_id: MEMBER }],
    ["source hash", { source_version: "b".repeat(64) }],
    ["recipient", { destination: "other@example.com" }],
    ["sender", { account_ref: "other@example.com" }],
    ["redirect", { preview: { ...card.preview as object, redirect_url: "https://wrong.example" } }],
    ["template hash", { preview: { ...card.preview as object, template_sha256: "bad" } }],
    ["template body", { preview: { ...card.preview as object, template_body: "" } }],
    ["target", { scope: { target_role: "employee", target_member_id: ID, target_client_id: null } }],
    ["roster generation", { preview: { ...card.preview as object, team_member_generation: null } }],
    ["expiry", { expires_at: "2036-01-01T00:00:00Z" }],
  ])("blocks changed %s evidence", (_name, change) => {
    const changed = { ...card, ...change } as InvitationInboxCard;
    expect(invitationApprovalBlocker(changed)).not.toBeNull();
    expect(invitationCanApprove(changed)).toBe(false);
  });

  it("offers reasoned closeout after expiry without approval", () => {
    const expired = { ...card, status: "expired", expires_at: "2020-01-01T00:00:00Z",
      preview: { ...card.preview as object, expires_at: "2020-01-01T00:00:00Z" } };
    expect(invitationCanApprove(expired)).toBe(false);
    expect(invitationCanReject(expired)).toBe(true);
  });
});
