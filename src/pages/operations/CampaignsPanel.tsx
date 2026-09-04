import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { DataTable } from "../../components/DataTable";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef } from "../../components/forms/fields";
import { loadClients, useOptions } from "../../lib/options";
import { supabase } from "../../lib/supabase";

type Campaign = {
  id: string;
  campaign_ref: string;
  target_role: string;
  daily_spend: number;
  total_spend: number;
  objective_achieved: string | null;
  status: "active" | "past";
};

/** Campaigns recruit for one of the three team roles. */
const TARGET_ROLE_OPTIONS = [
  { value: "smm", label: "SMM" },
  { value: "editor", label: "Editor" },
  { value: "avatar", label: "Avatar" },
];

const ROLE_LABEL: Record<string, string> = Object.fromEntries(
  TARGET_ROLE_OPTIONS.map((o) => [o.value, o.label]),
);

const COLUMNS = [
  "Campaign ID",
  "Target Role",
  "Daily Spend",
  "Total Spend",
  "Objective Achieved",
];

function toRow(c: Campaign) {
  return [
    c.campaign_ref,
    ROLE_LABEL[c.target_role] ?? c.target_role,
    Number(c.daily_spend).toFixed(2),
    Number(c.total_spend).toFixed(2),
    c.objective_achieved ?? "—",
  ];
}

export function CampaignsPanel() {
  const [addOpen, setAddOpen] = useState(false);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [totals, setTotals] = useState({ active: 0, dailySpend: 0 });
  const clientOptions = useOptions(loadClients, addOpen);

  const refresh = useCallback(async () => {
    const [rows, summary] = await Promise.all([
      supabase
        .from("campaigns")
        .select("id, campaign_ref, target_role, daily_spend, total_spend, objective_achieved, status")
        .order("started_on", { ascending: false }),
      supabase.from("campaign_totals").select("active_campaigns, current_daily_spend").maybeSingle(),
    ]);
    setCampaigns((rows.data ?? []) as Campaign[]);
    setTotals({
      active: Number(summary.data?.active_campaigns ?? 0),
      dailySpend: Number(summary.data?.current_daily_spend ?? 0),
    });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const fields: FieldDef[] = [
    { name: "campaign_ref", label: "Campaign ID", kind: "text", required: true },
    {
      name: "target_role",
      label: "Target role",
      kind: "select",
      required: true,
      options: TARGET_ROLE_OPTIONS,
    },
    { name: "daily_spend", label: "Daily spend", kind: "number", required: true },
    { name: "client_id", label: "Client", kind: "select", options: clientOptions },
    {
      name: "objective_achieved",
      label: "Objective achieved",
      kind: "text",
      hint: "Usually filled in later, once the campaign has run.",
    },
  ];

  const active = campaigns.filter((c) => c.status === "active");
  const past = campaigns.filter((c) => c.status === "past");

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button icon={Plus} onClick={() => setAddOpen(true)}>
          Add Campaign
        </Button>
      </div>

      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Panel title="Active Campaigns">
            <p className="text-2xl font-semibold text-card-foreground">{totals.active}</p>
          </Panel>
          <Panel title="Current Daily Spend">
            <p className="text-2xl font-semibold text-card-foreground">
              {totals.dailySpend.toFixed(2)}
            </p>
          </Panel>
        </div>

        <div>
          <h2 className="mb-3 text-sm font-semibold text-foreground">Active Campaigns</h2>
          <DataTable
            columns={COLUMNS}
            emptyLabel="No active campaigns"
            rows={active.map(toRow)}
          />
        </div>

        <div>
          <h2 className="mb-3 text-sm font-semibold text-foreground">Past Campaigns</h2>
          <DataTable columns={COLUMNS} emptyLabel="No past campaigns" rows={past.map(toRow)} />
        </div>
      </div>

      <FormModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Campaign"
        draftKey="add-campaign"
        fields={fields}
        submitLabel="Add campaign"
        onSubmit={async (v) => {
          const { error } = await supabase.from("campaigns").insert({
            campaign_ref: (v.campaign_ref as string).trim(),
            target_role: (v.target_role as string).trim(),
            daily_spend: Number(v.daily_spend),
            client_id: (v.client_id as string) || null,
            objective_achieved: (v.objective_achieved as string)?.trim() || null,
          });
          if (error) throw error;
        }}
        onSaved={refresh}
      />
    </div>
  );
}
