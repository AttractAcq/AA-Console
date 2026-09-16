import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../../components/Button";
import { Panel } from "../../../components/Panel";
import { EmptyState } from "../../../components/EmptyState";
import { ProfileDefinitionList } from "../../../components/ProfileDefinitionList";
import { FormModal } from "../../../components/forms/FormModal";
import { supabase } from "../../../lib/supabase";
import {
  TEAM_MEMBER_PROFILE_FIELDS,
  TEAM_MEMBER_PROFILE_SELECT,
  contactEntries,
  personalEntries,
  profileFromFormValues,
  profileHasContact,
  profileHasPersonal,
  profileToFormValues,
  resolveTeamMemberProfile,
  type TeamMemberProfile,
  type TeamMemberProfileRow,
} from "../../../lib/teamMemberProfile";

export function OverviewSection() {
  const [addOpen, setAddOpen] = useState(false);
  const { memberId } = useParams<{ memberId: string }>();
  const [row, setRow] = useState<TeamMemberProfileRow | null>(null);
  const [totals, setTotals] = useState({ compensation: 0, output: 0 });

  const refresh = useCallback(async () => {
    if (!memberId) return;
    // Total Compensation and Total Output are sums over other tables,
    // never stored on the member row.
    const [m, pay, out] = await Promise.all([
      supabase.from("team_members").select(TEAM_MEMBER_PROFILE_SELECT).eq("id", memberId).maybeSingle(),
      supabase.from("contract_payments").select("compensation").eq("member_id", memberId),
      supabase.from("client_media_assets").select("id", { count: "exact", head: true }).eq("member_id", memberId),
    ]);
    setRow((m.data as TeamMemberProfileRow | null) ?? null);
    setTotals({
      compensation: (pay.data ?? []).reduce((s, r) => s + Number(r.compensation), 0),
      output: out.count ?? 0,
    });
  }, [memberId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const profile: TeamMemberProfile = resolveTeamMemberProfile(row);
  const personal = personalEntries(profile);
  const contact = contactEntries(profile);

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button icon={Plus} onClick={() => setAddOpen(true)}>
          Add Information
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Panel title="Total Compensation">
          <p className="text-2xl font-semibold text-card-foreground">
            {totals.compensation.toFixed(2)}
          </p>
        </Panel>
        <Panel title="Total Output">
          <p className="text-2xl font-semibold text-card-foreground">{totals.output}</p>
        </Panel>
        <Panel title="Personal Information">
          {profileHasPersonal(profile) ? (
            <ProfileDefinitionList entries={personal} />
          ) : (
            <EmptyState label="Personal Information" minHeight={80} />
          )}
        </Panel>
        <Panel title="Contact Information">
          {profileHasContact(profile) ? (
            <ProfileDefinitionList entries={contact} />
          ) : (
            <EmptyState label="Contact Information" minHeight={80} />
          )}
        </Panel>
      </div>

      <FormModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Information"
        draftKey={`member-contract-profile:${memberId}`}
        intro="Total Compensation and Total Output are calculated from payments and delivered assets — they are not entered here."
        fields={TEAM_MEMBER_PROFILE_FIELDS}
        initialValues={profileToFormValues(profile)}
        onSubmit={async (v) => {
          if (!memberId) throw new Error("No team member selected.");
          const next = profileFromFormValues(v);
          const { error } = await supabase.from("team_members").update(next).eq("id", memberId);
          if (error) throw error;
        }}
        onSaved={refresh}
      />
    </div>
  );
}
