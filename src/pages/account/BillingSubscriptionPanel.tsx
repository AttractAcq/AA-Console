import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { EmptyState } from "../../components/EmptyState";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef, FormValues } from "../../components/forms/fields";
import { supabase } from "../../lib/supabase";

type Billing = {
  current_plan: string | null;
  monthly_amount: number | null;
  upsell_opportunity: string | null;
  started_on: string | null;
  duration_days: number | null;
};

const FIELDS: FieldDef[] = [
  { name: "current_plan", label: "Current plan", kind: "text", required: true },
  {
    name: "monthly_amount",
    label: "Monthly amount",
    kind: "number",
    required: true,
    hint: "The only source of agency MRR.",
  },
  { name: "started_on", label: "Started on", kind: "date", hint: "Client duration is derived from this." },
  { name: "upsell_opportunity", label: "Upsell opportunity", kind: "textarea", rows: 3 },
];

export function BillingSubscriptionPanel() {
  const [addOpen, setAddOpen] = useState(false);
  const { clientId } = useParams<{ clientId: string }>();
  const [billing, setBilling] = useState<Billing | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    const { data } = await supabase
      .from("client_billing_view")
      .select("current_plan, monthly_amount, upsell_opportunity, started_on, duration_days")
      .eq("client_id", clientId)
      .maybeSingle();
    setBilling((data as Billing) ?? null);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const initialValues: FormValues = {
    current_plan: billing?.current_plan ?? "",
    monthly_amount: billing?.monthly_amount != null ? String(billing.monthly_amount) : "",
    started_on: billing?.started_on ?? "",
    upsell_opportunity: billing?.upsell_opportunity ?? "",
  };

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button icon={Plus} onClick={() => setAddOpen(true)}>
          Add Information
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Panel title="Current Plan">
          {billing?.current_plan ? (
            <>
              <p className="text-lg font-semibold text-card-foreground">{billing.current_plan}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {billing.monthly_amount != null ? `${billing.monthly_amount} / month` : "—"}
              </p>
            </>
          ) : (
            <EmptyState label="Current Plan" minHeight={80} />
          )}
        </Panel>
        <Panel title="Upsell Opportunity">
          {billing?.upsell_opportunity ? (
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {billing.upsell_opportunity}
            </p>
          ) : (
            <EmptyState label="Upsell Opportunity" minHeight={80} />
          )}
        </Panel>
        <Panel title="Client Duration">
          <p className="text-2xl font-semibold text-card-foreground">
            {billing?.duration_days != null ? `${billing.duration_days} days` : "—"}
          </p>
        </Panel>
      </div>

      <FormModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Information"
        draftKey={`billing:${clientId}`}
        intro="Client duration is calculated from the start date, not entered."
        fields={FIELDS}
        initialValues={initialValues}
        onSubmit={async (v) => {
          if (!clientId) throw new Error("No client selected.");
          const { error } = await supabase.from("client_billing").upsert(
            {
              client_id: clientId,
              current_plan: (v.current_plan as string).trim(),
              monthly_amount: Number(v.monthly_amount),
              started_on: (v.started_on as string) || null,
              upsell_opportunity: (v.upsell_opportunity as string)?.trim() || null,
            },
            { onConflict: "client_id" },
          );
          if (error) throw error;
        }}
        onSaved={refresh}
      />
    </div>
  );
}
