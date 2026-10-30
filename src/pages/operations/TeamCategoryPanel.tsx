import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "../../components/Button";
import { TeamMemberCard } from "../../components/TeamMemberCard";
import { EmptyState } from "../../components/EmptyState";
import { FormModal } from "../../components/forms/FormModal";
import { teamMemberDraftKey } from "../../components/forms/draftStorage";
import { initialsFrom } from "../../components/forms/fields";
import type { FieldDef } from "../../components/forms/fields";
import { ENGAGEMENT_OPTIONS } from "../../lib/options";
import { supabase } from "../../lib/supabase";
import { callRuntime } from "../../lib/callRuntime";
import { teamCategoryLabels } from "../../data/team";
import type { TeamCategory, TeamMember } from "../../data/team";
import {
  TEAM_MEMBER_PROFILE_FIELDS,
  TEAM_MEMBER_PROFILE_SELECT,
  profileFromFormValues,
  profileToFormValues,
  resolveTeamMemberProfile,
  type TeamMemberProfileRow,
} from "../../lib/teamMemberProfile";

type MemberRow = TeamMemberProfileRow & {
  id: string;
  user_id: string | null;
  name: string;
  initials: string;
  engagement: "employee" | "contractor";
  active: boolean;
};

type InvitationSummary = {
  id: string;
  target_member_id: string | null;
  recipient_email: string;
  status: string;
  expires_at: string;
  payload_hash: string;
};

function invitationLabel(invitation: InvitationSummary): string {
  return ({
    expired: "Expired; cancel before making another request",
    requested: "Awaiting exact-version approval",
    approved: "Approved; sending disabled pending exact-email provider integration",
    sending: "Sending; do not retry",
    sent: "Invitation email sent",
    reconcile: "Send outcome needs manual review; do not resend",
    conflict: "Existing Auth account conflict",
    accepted: "Accepted",
    cancelled: "Cancelled",
    rejected: "Rejected",
  } as Record<string,string>)[invitation.status] ?? "Status unavailable";
}

const FIELDS: FieldDef[] = [
  { name: "name", label: "Name", kind: "text", required: true },
  {
    name: "initials",
    label: "Initials",
    kind: "text",
    derivedFrom: { field: "name", transform: initialsFrom },
  },
  { name: "engagement", label: "Engagement", kind: "select", options: ENGAGEMENT_OPTIONS },
];

const EDIT_FIELDS: FieldDef[] = [
  { name: "name", label: "Display name", kind: "text", required: true },
  { name: "initials", label: "Initials", kind: "text", derivedFrom: { field: "name", transform: initialsFrom } },
  { name: "engagement", label: "Engagement", kind: "select", options: ENGAGEMENT_OPTIONS },
  ...TEAM_MEMBER_PROFILE_FIELDS,
];

export function TeamCategoryPanel({ category }: { category: TeamCategory }) {
  const [addOpen, setAddOpen] = useState(false);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [editing, setEditing] = useState<MemberRow | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [inviting, setInviting] = useState<MemberRow | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteKey, setInviteKey] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [invitations, setInvitations] = useState<InvitationSummary[]>([]);
  const [inviteLoadError, setInviteLoadError] = useState<string | null>(null);
  const { addButtonLabel } = teamCategoryLabels[category];

  const [loadError, setLoadError] = useState<string | null>(null);

  const refreshInvitations = useCallback(async () => {
    try {
      const result = await callRuntime<{ invitations: InvitationSummary[] }>("/admin/invitations/list", {});
      setInvitations(result.invitations);
      setInviteLoadError(null);
    } catch {
      setInviteLoadError("Invitation states are unavailable. Check the runtime before requesting access.");
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const { data, error } = await supabase
        .from("team_members")
        .select(`id, user_id, name, initials, engagement, active, ${TEAM_MEMBER_PROFILE_SELECT}`)
        .eq("category", category)
        .order("name");
      if (error) throw error;
      setMembers((data ?? []) as MemberRow[]);
      setLoading(false);
    } catch (error) {
      setLoadError("Failed to load team members: " + (error instanceof Error ? error.message : (error as { message?: string })?.message ?? "Unknown query error"));
    } finally {
      setLoading(false);
    }
  }, [category]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        void refresh();
        void refreshInvitations();
      }
    });
    return () => { cancelled = true; };
  }, [refresh, refreshInvitations]);

  const editInitialValues = useMemo(() => editing ? {
    name: editing.name,
    initials: editing.initials,
    engagement: editing.engagement,
    ...profileToFormValues(resolveTeamMemberProfile(editing)),
  } : undefined, [editing]);

  // This used to promise "lose team access", and production does not keep that
  // promise. Migration 127 adds `tm.active` to accessible_client_ids,
  // can_access_client, is_member and current_member_id; until it is applied
  // every one of them ignores `active`, so a retired member keeps every client
  // they were assigned to. Retiring still does real work — they leave the
  // roster and dispatch_brief_to_members filters on `active = true`, so they
  // stop being sent briefs — which is why this warns rather than refusing.
  //
  // When 127 lands, the second sentence here and the note under the retired
  // list can both go, and the original wording is correct again.
  async function setRetired(member: MemberRow, retired: boolean) {
    if (retired && !window.confirm(`Retire ${member.name}? They leave the active roster and stop being sent briefs. Their sign-in and access to clients they are assigned to are not revoked yet, so clear their client assignments too if that matters. Past work and payments will remain.`)) return;
    setActionError(null);
    setNotice(null);
    const { error } = await supabase.from("team_members")
      .update({ active: !retired })
      .eq("id", member.id)
      .eq("category", category);
    if (error) {
      setActionError(error.message);
      return;
    }
    setNotice(`${member.name} ${retired ? "retired" : "restored"}.`);
    await refresh();
  }

  async function cancelInvitation(invitation: InvitationSummary) {
    const reason = window.prompt("Why should this invitation be cancelled?")?.trim();
    if (!reason) return;
    setActionError(null);
    const assurance = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (assurance.error || assurance.data.currentLevel !== "aal2") {
      setActionError("Complete MFA to reach AAL2 before cancelling an invitation.");
      return;
    }
    const { error } = await supabase.rpc("cancel_console_invitation_v6", {
      p_request_id: invitation.id, p_reason: reason,
    });
    if (error) {
      setActionError(error.message);
      return;
    }
    setNotice("Invitation cancelled. The approval history remains in the Inbox.");
    await refreshInvitations();
  }

  async function resolveUncertainInvitation(invitation: InvitationSummary) {
    const evidenceRef = window.prompt("Retained provider no-send evidence reference (no links or tokens):")?.trim();
    if (!evidenceRef) return;
    const evidenceHash = window.prompt("SHA-256 of that retained evidence:")?.trim().toLowerCase();
    if (!evidenceHash || !/^[0-9a-f]{64}$/.test(evidenceHash)) {
      setActionError("A 64-character SHA-256 evidence hash is required.");
      return;
    }
    const reason = window.prompt("Why is this send proven not to have reached the provider?")?.trim();
    if (!reason) return;
    setActionError(null);
    const assurance = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (assurance.error || assurance.data.currentLevel !== "aal2") {
      setActionError("Complete MFA to reach AAL2 before resolving an uncertain send.");
      return;
    }
    const { error } = await supabase.rpc("resolve_console_invitation_uncertain_v6", {
      p_request_id: invitation.id, p_expected_hash: invitation.payload_hash,
      p_evidence_ref: evidenceRef, p_evidence_sha256: evidenceHash,
      p_reason: reason,
    });
    if (error) {
      setActionError("The uncertain send could not be resolved. Verify the Auth account and provider evidence before retrying.");
      return;
    }
    setNotice("Uncertain send resolved and canonical approval revoked. No email was retried.");
    await refreshInvitations();
  }

  const activeMembers = members.filter((member) => member.active);
  const retiredMembers = members.filter((member) => !member.active);

  function card(member: MemberRow, retired: boolean) {
    const memberInvitations = invitations.filter((item) => item.target_member_id === member.id);
    const held = memberInvitations.some((item) => !["rejected", "cancelled"].includes(item.status));
    const summary: TeamMember = {
      id: member.id,
      name: member.name,
      initials: member.initials,
      engagementType: member.engagement === "employee" ? "Employee" : "Contractor",
    };
    return <div key={member.id}>
      <TeamMemberCard
        category={category}
        member={summary}
        onEdit={() => setEditing(member)}
        onRetire={retired ? undefined : () => void setRetired(member, true)}
        onRestore={retired ? () => void setRetired(member, false) : undefined}
      />
      {(memberInvitations.length > 0 || (!retired && !member.user_id)) && (
        <div className="mt-2 text-sm">
          {memberInvitations.map((invitation) => <div key={invitation.id} className="mb-1">
            <p role="status">{invitation.recipient_email}: {invitationLabel(invitation)}</p>
            {invitation.status === "requested" && <Link className="text-brand-strong underline" to="/approvals">Review in Approval Inbox</Link>}
            {["requested", "approved", "sent", "conflict", "expired"].includes(invitation.status)
              && <button type="button" className="ml-3 text-destructive underline"
                onClick={() => void cancelInvitation(invitation)}>Cancel invitation</button>}
            {["sending", "reconcile"].includes(invitation.status)
              && <button type="button" className="ml-3 text-destructive underline"
                onClick={() => void resolveUncertainInvitation(invitation)}>
                Resolve uncertain send after provider check
              </button>}
          </div>)}
          {!retired && !member.user_id && !held && !inviteLoadError && <button type="button" className="text-brand-strong underline"
            onClick={() => { setInviting(member); setInviteEmail(""); setInviteKey(crypto.randomUUID()); setActionError(null); }}>
            Invite {member.name}
          </button>}
        </div>
      )}
    </div>;
  }

  if (loadError) return <div role="alert"><p>{loadError}</p><button type="button" onClick={() => void refresh()}>Retry</button></div>;

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button icon={Plus} onClick={() => setAddOpen(true)}>
          {addButtonLabel}
        </Button>
      </div>

      {actionError && <p role="alert" className="mb-4 text-sm text-destructive">{actionError}</p>}
      {notice && <p role="status" className="mb-4 text-sm text-brand-strong">{notice}</p>}
      {inviteLoadError && members.some((member) => member.active && !member.user_id)
        && <p role="alert" className="mb-4 text-sm text-destructive">{inviteLoadError}</p>}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading team…</p>
      ) : activeMembers.length === 0 ? (
        <EmptyState label={`No ${category} yet`} />
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {activeMembers.map((member) => card(member, false))}
        </div>
      )}

      {retiredMembers.length > 0 && (
        <div className="mt-6">
          <button type="button" onClick={() => setShowRetired((value) => !value)} className="text-sm font-medium text-brand-strong hover:underline">
            {showRetired ? "Hide" : "Show"} retired ({retiredMembers.length})
          </button>
          {showRetired && (
            <>
              <p className="mt-2 text-sm text-muted-foreground">
                Retiring takes someone off the roster and stops new briefs reaching them. It does not
                yet revoke their sign-in or their access to clients they were assigned to — clear
                their client assignments as well if that matters.
              </p>
              <div className="mt-3 grid gap-4 md:grid-cols-3">{retiredMembers.map((member) => card(member, true))}</div>
            </>
          )}
        </div>
      )}

      {inviting && <form className="mt-6 rounded-lg border border-border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (inviteBusy) return;
          setInviteBusy(true);
          setActionError(null);
          void callRuntime<{ requestId: string; status: string }>("/admin/invitations/request", {
            email: inviteEmail, targetRole: "employee", memberId: inviting.id,
            idempotencyKey: inviteKey,
          }).then(async () => {
            setNotice(`Invitation for ${inviting.name} is awaiting exact-version approval.`);
            setInviting(null);
            await refreshInvitations();
          }).catch((error: unknown) => {
            setActionError(error instanceof Error ? error.message : "Could not request invitation.");
          }).finally(() => setInviteBusy(false));
        }}>
        <h3 className="font-semibold">Invite {inviting.name}</h3>
        <p className="mt-1 text-sm text-muted-foreground">One recipient, role, roster target, sender and expiry will be frozen for human review before email is sent.</p>
        <label className="mt-3 block text-sm" htmlFor="team-invite-email">Recipient email</label>
        <input id="team-invite-email" className="mt-1 w-full rounded border border-border bg-background p-2"
          type="email" required autoComplete="email" value={inviteEmail}
          onChange={(event) => { setInviteEmail(event.target.value); setInviteKey(crypto.randomUUID()); }} />
        <div className="mt-3 flex gap-3">
          <button type="submit" disabled={inviteBusy}
            className="rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {inviteBusy ? "Requesting…" : "Request invitation"}
          </button>
          <button type="button" onClick={() => setInviting(null)}>Cancel</button>
        </div>
      </form>}

      <FormModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title={addButtonLabel}
        draftKey={teamMemberDraftKey(category)}
        fields={FIELDS}
        intro="This adds a team roster entry without a login. Login access requires an approved invitation."
        submitLabel="Add"
        onSubmit={async (v) => {
          const { error } = await supabase.rpc("admin_create_team_member", {
            p_name: (v.name as string).trim(),
            p_initials: ((v.initials as string) || initialsFrom(v.name as string)).trim().toUpperCase(),
            p_category: category,
            p_engagement: ((v.engagement as string) || "contractor") as "employee" | "contractor",
          });
          if (error) throw new Error(error.message);
        }}
        onSaved={refresh}
      />

      <FormModal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={`Edit ${editing?.name ?? "profile"}`}
        fields={EDIT_FIELDS}
        initialValues={editInitialValues}
        submitLabel="Save profile"
        onSubmit={async (values) => {
          if (!editing) throw new Error("No team member selected.");
          const name = (values.name as string).trim();
          const { error } = await supabase.from("team_members").update({
            name,
            initials: ((values.initials as string) || initialsFrom(name)).trim().toUpperCase(),
            engagement: ((values.engagement as string) || editing.engagement) as "employee" | "contractor",
            ...profileFromFormValues(values),
            // The form includes values parsed from legacy free text. Clear it
            // so removing a contact field does not make an old value reappear.
            personal_info: null,
            contact_info: null,
          }).eq("id", editing.id).eq("category", category);
          if (error) throw error;
          setNotice(`${name}'s profile saved.`);
        }}
        onSaved={refresh}
      />
    </div>
  );
}
