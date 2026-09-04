import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { DataTable } from "../../components/DataTable";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef } from "../../components/forms/fields";
import { STATEMENT_OPTIONS } from "../../lib/options";
import { supabase } from "../../lib/supabase";

type Period = { period: string; cac: number | null; ltv: number | null };
type Entry = { id: string; period: string; statement: string; line_item: string; amount: number };

const PERIOD_FIELDS: FieldDef[] = [
  { name: "period", label: "Month", kind: "date", required: true, hint: "Any day in the month." },
  { name: "cac", label: "CAC", kind: "number", hint: "Manual — nothing records ad spend yet." },
  { name: "ltv", label: "LTV", kind: "number", hint: "Manual — nothing records churn yet." },
];

const ENTRY_FIELDS: FieldDef[] = [
  { name: "period", label: "Month", kind: "date", required: true },
  { name: "statement", label: "Statement", kind: "select", required: true, options: STATEMENT_OPTIONS },
  { name: "line_item", label: "Line item", kind: "text", required: true },
  { name: "amount", label: "Amount", kind: "number", required: true },
];

function firstOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function FinancialsPanel() {
  const [periodOpen, setPeriodOpen] = useState(false);
  const [entryOpen, setEntryOpen] = useState(false);
  const [mrr, setMrr] = useState(0);
  const [latest, setLatest] = useState<Period | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);

  const refresh = useCallback(async () => {
    const [billing, periods, lines] = await Promise.all([
      supabase.from("mrr_from_billing").select("mrr").maybeSingle(),
      supabase.from("finance_periods").select("period, cac, ltv").order("period", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("finance_entries").select("id, period, statement, line_item, amount").order("period", { ascending: false }).limit(50),
    ]);
    setMrr(Number(billing.data?.mrr ?? 0));
    setLatest((periods.data as Period) ?? null);
    setEntries((lines.data ?? []) as Entry[]);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div>
      <div className="mb-4 flex justify-end gap-2">
        <Button icon={Plus} onClick={() => setPeriodOpen(true)}>
          Add Input
        </Button>
        <Button icon={Plus} onClick={() => setEntryOpen(true)}>
          Add Statement Line
        </Button>
      </div>

      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-3">
          <Panel title="MRR">
            <p className="text-2xl font-semibold text-card-foreground">{mrr.toFixed(2)}</p>
            <p className="mt-1 text-xs text-muted-foreground">Summed from client billing</p>
          </Panel>
          <Panel title="CAC">
            <p className="text-2xl font-semibold text-card-foreground">{latest?.cac ?? "—"}</p>
          </Panel>
          <Panel title="LTV">
            <p className="text-2xl font-semibold text-card-foreground">{latest?.ltv ?? "—"}</p>
          </Panel>
        </div>

        <DataTable
          columns={["Month", "Statement", "Line Item", "Amount"]}
          emptyLabel="No statement lines yet"
          rows={entries.map((e) => [e.period, e.statement, e.line_item, Number(e.amount).toFixed(2)])}
        />
      </div>

      <FormModal
        open={periodOpen}
        onClose={() => setPeriodOpen(false)}
        title="Add Input"
        draftKey={"finance-period"}
        intro="MRR is calculated from client billing and is not entered here."
        fields={PERIOD_FIELDS}
        onSubmit={async (v) => {
          const { error } = await supabase.from("finance_periods").upsert(
            {
              period: firstOfMonth(v.period as string),
              cac: v.cac ? Number(v.cac) : null,
              ltv: v.ltv ? Number(v.ltv) : null,
            },
            { onConflict: "period" },
          );
          if (error) throw error;
        }}
        onSaved={refresh}
      />

      <FormModal
        open={entryOpen}
        onClose={() => setEntryOpen(false)}
        title="Add Statement Line"
        draftKey={"finance-entry"}
        fields={ENTRY_FIELDS}
        onSubmit={async (v) => {
          const { error } = await supabase.from("finance_entries").insert({
            period: firstOfMonth(v.period as string),
            statement: v.statement as string,
            line_item: (v.line_item as string).trim(),
            amount: Number(v.amount),
          });
          if (error) throw error;
        }}
        onSaved={refresh}
      />
    </div>
  );
}
