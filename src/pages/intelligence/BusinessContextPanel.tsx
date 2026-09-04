import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { EmptyState } from "../../components/EmptyState";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef, FormValues } from "../../components/forms/fields";
import { supabase } from "../../lib/supabase";

/**
 * The root of the whole application. Every agent reads this, and the four
 * required fields are the ones with no other source in the system.
 */
const FIELDS: FieldDef[] = [
  { name: "business_overview", label: "Business overview", kind: "textarea", rows: 4, required: true,
    hint: "Read by every agent." },
  { name: "ideal_customer", label: "Ideal customer", kind: "textarea", rows: 3, required: true,
    hint: "Seeds the ICP agent." },
  { name: "main_offer", label: "Main offer", kind: "textarea", rows: 3, required: true },
  { name: "competitors", label: "Competitors", kind: "textarea", rows: 3, required: true,
    hint: "Seeds the Competitor agent." },
  { name: "brand_voice", label: "Brand voice", kind: "textarea", rows: 3,
    hint: "Tone, language rules, and what never to say." },
  { name: "proof_testimonials", label: "Proof / testimonials", kind: "textarea", rows: 3 },
  { name: "current_marketing", label: "Current marketing", kind: "textarea", rows: 3 },
  { name: "sales_process", label: "Sales process", kind: "textarea", rows: 3 },
  { name: "current_revenue", label: "Current revenue", kind: "text" },
  { name: "target_revenue", label: "Target revenue", kind: "text" },
];

const CARDS: Array<{ key: string; label: string; hero?: boolean }> = [
  { key: "business_overview", label: "Business Overview", hero: true },
  { key: "current_revenue", label: "Current Revenue" },
  { key: "target_revenue", label: "Target Revenue" },
  { key: "current_marketing", label: "Current Marketing" },
  { key: "ideal_customer", label: "Ideal Customer" },
  { key: "main_offer", label: "Main Offer" },
  { key: "competitors", label: "Competitors" },
  { key: "proof_testimonials", label: "Proof / Testimonials" },
];

type ContextRow = Record<string, string | null>;

export function BusinessContextPanel() {
  const [inputOpen, setInputOpen] = useState(false);
  const { clientId } = useParams<{ clientId: string }>();
  const [row, setRow] = useState<ContextRow | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    const { data } = await supabase
      .from("client_business_context")
      .select("*")
      .eq("client_id", clientId)
      .maybeSingle();
    setRow((data as ContextRow) ?? null);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const initialValues: FormValues = Object.fromEntries(
    FIELDS.map((f) => [f.name, row?.[f.name] ?? ""]),
  );

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button icon={Plus} onClick={() => setInputOpen(true)}>
          Business Input
        </Button>
      </div>

      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {CARDS.map(({ key, label, hero }) => {
            const value = row?.[key];
            return (
              <Panel
                key={key}
                title={label}
                className={hero ? "sm:col-span-2 lg:col-span-4" : undefined}
              >
                {value ? (
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">{value}</p>
                ) : (
                  <EmptyState label={label} minHeight={hero ? 100 : 80} />
                )}
              </Panel>
            );
          })}
        </div>
      </div>

      <FormModal
        open={inputOpen}
        onClose={() => setInputOpen(false)}
        title="Business Input"
        draftKey={`business-context:${clientId}`}
        intro="The four required fields are what every downstream agent reads. Partial saves are fine."
        fields={FIELDS}
        initialValues={initialValues}
        onSubmit={async (values) => {
          if (!clientId) throw new Error("No client selected.");
          const payload = Object.fromEntries(
            FIELDS.map((f) => [f.name, (values[f.name] as string)?.trim() || null]),
          );
          const { error } = await supabase
            .from("client_business_context")
            .upsert({ client_id: clientId, ...payload }, { onConflict: "client_id" });
          if (error) throw error;
        }}
        onSaved={refresh}
      />
    </div>
  );
}
