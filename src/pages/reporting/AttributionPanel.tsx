import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { supabase } from "../../lib/supabase";
import { cn } from "../../lib/cn";

type Funnel = {
  leads: number;
  conversations: number;
  appointments: number;
  sales: number;
  lost: number;
  pipeline_value: number;
  sale_value: number;
  cash_collected: number;
  spend: number;
  lead_to_sale_pct: number | null;
  cost_per_lead: number | null;
  return_on_spend: number | null;
};

type TopContent = {
  asset_ref: string | null;
  asset_title: string | null;
  hook: string | null;
  idea_title: string | null;
  content_territory: string | null;
  leads: number;
  sales: number;
  cash_collected: number;
  spend: number;
  impressions: number;
};

const WINDOWS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

const money = (v: number | null) => (v === null ? "—" : `R${Number(v).toLocaleString()}`);

/**
 * What caused what.
 *
 * Every ratio here is null rather than zero when its denominator is zero,
 * because "no leads yet" and "nothing converted" are different facts and only
 * one of them is bad news. Showing 0% for the first is a lie a client would
 * read and act on.
 */
export function AttributionPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [days, setDays] = useState(30);
  const [funnel, setFunnel] = useState<Funnel | null>(null);
  const [top, setTop] = useState<TopContent[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    const [f, t] = await Promise.all([
      supabase.rpc("acquisition_funnel", { p_client_id: clientId, p_days: days }),
      supabase.rpc("top_content_by_revenue", { p_client_id: clientId, p_limit: 10 }),
    ]);
    setFunnel(((f.data ?? [])[0] as Funnel) ?? null);
    setTop((t.data ?? []) as TopContent[]);
    setLoading(false);
  }, [clientId, days]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) return <p className="text-sm text-muted-foreground">Loading attribution…</p>;

  const chain: Array<[string, number]> = funnel
    ? [
        ["Leads", funnel.leads],
        ["Conversations", funnel.conversations],
        ["Appointments", funnel.appointments],
        ["Sales", funnel.sales],
      ]
    : [];

  const attributed = top.filter((r) => r.leads > 0).length;
  const noSpendYet = (funnel?.spend ?? 0) === 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        {WINDOWS.map((w) => (
          <button
            key={w.days}
            type="button"
            onClick={() => setDays(w.days)}
            className={cn(
              "rounded-full border px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              days === w.days
                ? "border-primary bg-primary/5 text-foreground"
                : "border-border text-muted-foreground hover:border-primary/50",
            )}
          >
            {w.label}
          </button>
        ))}
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-foreground">The chain</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {chain.map(([label, value]) => (
            <div key={label} className="rounded-lg border border-border bg-card p-4">
              <p className="text-sm text-muted-foreground">{label}</p>
              <p className="mt-1 text-2xl font-semibold text-card-foreground">{value}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">Cash collected</p>
          <p className="mt-1 text-2xl font-semibold text-card-foreground">
            {money(funnel?.cash_collected ?? 0)}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">Lead to sale</p>
          <p className="mt-1 text-2xl font-semibold text-card-foreground">
            {funnel?.lead_to_sale_pct === null || funnel?.lead_to_sale_pct === undefined
              ? "—"
              : `${funnel.lead_to_sale_pct}%`}
          </p>
          {funnel?.lead_to_sale_pct === null && (
            <p className="mt-1 text-xs text-muted-foreground">No leads in this window yet.</p>
          )}
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">Cost per lead</p>
          <p className="mt-1 text-2xl font-semibold text-card-foreground">
            {money(funnel?.cost_per_lead ?? null)}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">Return on spend</p>
          <p className="mt-1 text-2xl font-semibold text-card-foreground">
            {funnel?.return_on_spend === null || funnel?.return_on_spend === undefined
              ? "—"
              : `${funnel.return_on_spend}×`}
          </p>
        </div>
      </div>

      {/* Said once, plainly, rather than leaving four dashes to be read as
          "performed badly". */}
      {noSpendYet && (
        <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          No spend or impressions are recorded yet, so cost per lead and return on spend cannot be
          calculated. Connect Meta under Account → Integrations and the attention half of this
          chain fills in. The revenue half above does not depend on it.
        </p>
      )}

      <div>
        <h2 className="mb-3 text-sm font-semibold text-foreground">
          What produced the revenue
        </h2>
        {top.length === 0 ? (
          <EmptyState label="No assets yet, so nothing to attribute revenue to." />
        ) : (
          <>
            <DataTable
              columns={["Asset", "Hook", "From the idea", "Leads", "Sales", "Cash"]}
              emptyLabel=""
              rows={top.map((r) => [
                `${r.asset_ref ?? "—"} · ${r.asset_title ?? "Untitled"}`,
                r.hook ?? "—",
                r.idea_title ?? "—",
                String(r.leads),
                String(r.sales),
                money(r.cash_collected),
              ])}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              {attributed === 0
                ? "No lead has recorded which asset it came from yet, so nothing can be attributed. A lead's source is set when it is created."
                : `${attributed} of ${top.length} assets have a lead attributed to them.`}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
