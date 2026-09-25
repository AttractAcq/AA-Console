import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { TeamMemberCard } from "../../components/TeamMemberCard";
import { EmptyState } from "../../components/EmptyState";
import { FormModal } from "../../components/forms/FormModal";
import { initialsFrom } from "../../components/forms/fields";
import type { FieldDef } from "../../components/forms/fields";
import { ENGAGEMENT_OPTIONS } from "../../lib/options";
import { supabase } from "../../lib/supabase";
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
  name: string;
  initials: string;
  engagement: "employee" | "contractor";
  active: boolean;
};

const FIELDS: FieldDef[] = [
  { name: "name", label: "Name", kind: "text", required: true },
  {
    name: "initials",
    label: "Initials",
    kind: "text",
    derivedFrom: { field: "name", transform: initialsFrom },
  },
  { name: "engagement", label: "Engagement", kind: "select", options: ENGAGEMENT_OPTIONS },
  {
    name: "username",
    label: "Username",
    kind: "text",
    hint: "Creates their Employee console login. Without it they cannot sign in.",
  },
  { name: "password", label: "Password", kind: "password", hint: "Shown once — write it down." },
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
  const { addButtonLabel } = teamCategoryLabels[category];

  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const { data, error } = await supabase
        .from("team_members")
        .select(`id, name, initials, engagement, active, ${TEAM_MEMBER_PROFILE_SELECT}`)
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
    void refresh();
  }, [refresh]);

  const editInitialValues = useMemo(() => editing ? {
    name: editing.name,
    initials: editing.initials,
    engagement: editing.engagement,
    ...profileToFormValues(resolveTeamMemberProfile(editing)),
  } : undefined, [editing]);

  async function setRetired(member: MemberRow, retired: boolean) {
    if (retired && !window.confirm(`Retire ${member.name}? They will leave the active roster and lose team access. Past work and payments will remain.`)) return;
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

  const activeMembers = members.filter((member) => member.active);
  const retiredMembers = members.filter((member) => !member.active);

  function card(member: MemberRow, retired: boolean) {
    const summary: TeamMember = {
      id: member.id,
      name: member.name,
      initials: member.initials,
      engagementType: member.engagement === "employee" ? "Employee" : "Contractor",
    };
    return <TeamMemberCard
      key={member.id}
      category={category}
      member={summary}
      onEdit={() => setEditing(member)}
      onRetire={retired ? undefined : () => void setRetired(member, true)}
      onRestore={retired ? () => void setRetired(member, false) : undefined}
    />;
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
          {showRetired && <div className="mt-3 grid gap-4 md:grid-cols-3">{retiredMembers.map((member) => card(member, true))}</div>}
        </div>
      )}

      <FormModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title={addButtonLabel}
        draftKey={`team-member:${category}`}
        fields={FIELDS}
        submitLabel="Add"
        onSubmit={async (v) => {
          const { error } = await supabase.rpc("admin_create_team_member", {
            p_name: (v.name as string).trim(),
            p_initials: ((v.initials as string) || initialsFrom(v.name as string)).trim().toUpperCase(),
            p_category: category,
            p_engagement: ((v.engagement as string) || "contractor") as "employee" | "contractor",
            p_username: (v.username as string)?.trim() || undefined,
            p_password: (v.password as string) || undefined,
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
