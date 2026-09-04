import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../../components/Button";
import { Panel } from "../../../components/Panel";
import { EmptyState } from "../../../components/EmptyState";
import { FormModal } from "../../../components/forms/FormModal";
import type { FieldDef, FormValues } from "../../../components/forms/fields";
import { supabase } from "../../../lib/supabase";

const FIELDS: FieldDef[] = [
  { name: "personal_info", label: "Personal information", kind: "textarea", rows: 4 },
  { name: "contact_info", label: "Contact information", kind: "textarea", rows: 3 },
];

export function OverviewSection() {
  const [addOpen, setAddOpen] = useState(false);
  const { memberId } = useParams<{ memberId: string }>();
  const [member, setMember] = useState<{ personal_info: string | null; contact_info: string | null } | null>(null);
  const [totals, setTotals] = useState({ compensation: 0, output: 0 });

  const refresh = useCallback(async () => {
    if (!memberId) return;
    // Total Compensation and Total Output are sums over other tables,
    // never stored on the member row.
    const [m, pay, out] = await Promise.all([
      supabase.from("team_members").select("personal_info, contact_info").eq("id", memberId).maybeSingle(),
      supabase.from("contract_payments").select("compensation").eq("member_id", memberId),
      supabase.from("client_media_assets").select("id", { count: "exact", head: true }).eq("member_id", memberId),
    ]);
    setMember(m.data ?? null);
    setTotals({
      compensation: (pay.data ?? []).reduce((s, r) => s + Number(r.compensation), 0),
      output: out.count ?? 0,
    });
  }, [memberId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const initialValues: FormValues = {
    personal_info: member?.personal_info ?? "",
    contact_info: member?.contact_info ?? "",
  };

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
          {member?.personal_info ? (
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{member.personal_info}</p>
          ) : (
            <EmptyState label="Personal Information" minHeight={80} />
          )}
        </Panel>
        <Panel title="Contact Information">
          {member?.contact_info ? (
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{member.contact_info}</p>
          ) : (
            <EmptyState label="Contact Information" minHeight={80} />
          )}
        </Panel>
      </div>

      <FormModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Information"
        draftKey={`member-info:${memberId}`}
        intro="Total Compensation and Total Output are calculated from payments and delivered assets — they are not entered here."
        fields={FIELDS}
        initialValues={initialValues}
        onSubmit={async (v) => {
          if (!memberId) throw new Error("No team member selected.");
          const { error } = await supabase
            .from("team_members")
            .update({
              personal_info: (v.personal_info as string)?.trim() || null,
              contact_info: (v.contact_info as string)?.trim() || null,
            })
            .eq("id", memberId);
          if (error) throw error;
        }}
        onSaved={refresh}
      />
    </div>
  );
}
