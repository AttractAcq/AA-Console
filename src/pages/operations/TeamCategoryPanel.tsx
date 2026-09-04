import { useCallback, useEffect, useState } from "react";
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

export function TeamCategoryPanel({ category }: { category: TeamCategory }) {
  const [addOpen, setAddOpen] = useState(false);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const { addButtonLabel } = teamCategoryLabels[category];

  const refresh = useCallback(async () => {
    const { data } = await supabase
      .from("team_members")
      .select("id, name, initials, engagement")
      .eq("category", category)
      .eq("active", true)
      .order("name");
    setMembers(
      (data ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        initials: m.initials,
        engagementType: m.engagement === "employee" ? "Employee" : "Contractor",
      })),
    );
    setLoading(false);
  }, [category]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button icon={Plus} onClick={() => setAddOpen(true)}>
          {addButtonLabel}
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading team…</p>
      ) : members.length === 0 ? (
        <EmptyState label={`No ${category} yet`} />
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {members.map((member) => (
            <TeamMemberCard key={member.id} category={category} member={member} />
          ))}
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
    </div>
  );
}
