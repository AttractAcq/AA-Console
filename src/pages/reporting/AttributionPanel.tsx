import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { supabase } from "../../lib/supabase";
import { cn } from "../../lib/cn";
import { BusinessProfileCoverage } from "./BusinessProfileCoverage";

type Funnel = {
  leads: number;
  conversations: number;
  appointments: number;
  sales: number;
  lost: number;
  pipeline_value: number | null;
  sale_value: number | null;
  cash_collected: number | null;
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
  cash_collected: number | null;
  spend: number;
  impressions: number;
};

type Coverage = {
  lead_rows: number;
  sourced_leads: number;
  consented_leads: number;
  spend_rows: number;
  spend_currencies: number;
  spend_currency: string | null;
  latest_spend_date: string | null;
  paid_metric_days: number;
  latest_paid_metric_date: string | null;
  latest_meta_read_at: string | null;
  latest_google_read_at: string | null;
};

type Journey = {
  lead_id: string;
  lead_created_at: string;
  lead_stage: string;
  source_channel: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  campaign_mode: string | null;
  opportunity_ids: string[];
  offer_version_id: string | null;
  asset_id: string | null;
  asset_title: string | null;
  page_id: string | null;
  page_title: string | null;
  sales_agent_id: string | null;
  sale_value: number | null;
  cash_collected: number | null;
  outcome_events: number;
  route_package_ids: string[];
  capture_submissions: number;
  unknown_route_submissions: number;
};

const WINDOWS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

const amount = (v: number | null) => (v === null ? "—" : Number(v).toLocaleString());
const spendMoney = (v: number | null, currency: string | null) =>
  v === null ? "—" : currency === "ZAR" ? `R${Number(v).toLocaleString()}`
    : `${currency ?? "currency unknown"} ${Number(v).toLocaleString()}`;

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
  return <ClientAttributionPanel key={clientId ?? "no-client"} clientId={clientId} />;
}

function ClientAttributionPanel({ clientId }: { clientId: string | undefined }) {
  const [days, setDays] = useState(30);
  const [funnel, setFunnel] = useState<Funnel | null>(null);
  const [top, setTop] = useState<TopContent[]>([]);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [journeys, setJourneys] = useState<Journey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const activeVisit = useRef(true);

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    const isCurrent = () => activeVisit.current && generation === requestGeneration.current;
    if (!clientId) {
      if (isCurrent()) setLoading(false);
      return;
    }
    if (isCurrent()) setLoading(true);
    const [f, t, c, j] = await Promise.all([
      supabase.rpc("acquisition_funnel", { p_client_id: clientId, p_days: days }),
      supabase.rpc("top_content_by_revenue", { p_client_id: clientId, p_limit: 10 }),
      supabase.rpc("acquisition_coverage_v8", { p_client_id: clientId, p_days: days }),
      supabase.rpc("lead_journey_trace_v9", { p_client_id: clientId, p_days: days, p_limit: 50 }),
    ]);
    if (!isCurrent()) return;
    if (f.error || t.error || c.error || j.error || !f.data?.[0] || !c.data?.[0]) {
      setError(f.error?.message ?? t.error?.message ?? c.error?.message ?? j.error?.message
        ?? "Attribution data is unavailable.");
      setFunnel(null); setTop([]); setCoverage(null); setJourneys([]); setLoading(false);
      return;
    }
    setError(null);
    setFunnel(f.data[0] as Funnel);
    setTop((t.data ?? []) as TopContent[]);
    setCoverage(c.data[0] as Coverage);
    setJourneys((j.data ?? []) as Journey[]);
    setLoading(false);
  }, [clientId, days]);

  useEffect(() => {
    activeVisit.current = true;
    let cancelled = false;
    void refresh().catch((cause) => {
      if (cancelled || !activeVisit.current) return;
      setError(cause instanceof Error ? cause.message : "Attribution data is unavailable.");
      setLoading(false);
    });
    return () => {
      cancelled = true;
      activeVisit.current = false;
      requestGeneration.current += 1;
    };
  }, [refresh]);

  if (loading) return <p className="text-sm text-muted-foreground">Loading attribution…</p>;
  if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>;

  const chain: Array<[string, number]> = funnel
    ? [
        ["Leads", funnel.leads],
        ["Conversations", funnel.conversations],
        ["Appointments", funnel.appointments],
        ["Sales", funnel.sales],
      ]
    : [];

  const attributed = top.filter((r) => r.leads > 0).length;
  const noSpendRows = coverage?.spend_rows === 0;
  const mixedCurrencies = (coverage?.spend_currencies ?? 0) > 1;
  const singleSpendCurrency = !!coverage && coverage.spend_rows > 0
    && coverage.spend_currencies === 1 && !!coverage.spend_currency;

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

      <section>
        <h2 className="mb-2 text-sm font-semibold text-foreground">Recorded lead journeys</h2>
        <p className="mb-3 text-xs text-muted-foreground">Latest 50 non-test leads in this window. Route IDs record capture doors, not which route caused a sale or whether a provider action ran. Unknown links remain unknown; archived source records remain traceable. Lead money currencies are stored separately but are not shown in this journey view.</p>
        <DataTable columns={["Lead", "Source / route", "Campaign", "Opportunity / offer", "Asset / page / agent", "Outcome", "Recorded sale / cash"]}
          emptyLabel="No recorded lead journeys in this window."
          rows={journeys.map((j) => [
            <span title={j.lead_id}>{j.lead_id.slice(0, 8)} · {new Date(j.lead_created_at).toLocaleDateString()}</span>,
            <span>{j.source_channel ?? "unknown"}<br />{j.route_package_ids.length
              ? j.route_package_ids.map((id) => <span key={id} title={id}>route {id.slice(0, 8)}<br /></span>)
              : "route unknown"}{j.unknown_route_submissions > 0 ? ` · ${j.unknown_route_submissions} unlinked capture${j.unknown_route_submissions === 1 ? "" : "s"}` : ""}</span>,
            j.campaign_id ? <span title={j.campaign_id}>{j.campaign_name ?? j.campaign_id.slice(0, 8)}{j.campaign_mode ? ` · ${j.campaign_mode}` : ""}</span> : "unknown",
            <span>{j.opportunity_ids.length ? `${j.opportunity_ids.length} linked` : "opportunity unknown"}<br />{j.offer_version_id ? <span title={j.offer_version_id}>offer {j.offer_version_id.slice(0, 8)}</span> : "offer unknown"}</span>,
            <span>{j.asset_id ? <span title={j.asset_id}>{j.asset_title ?? `asset ${j.asset_id.slice(0, 8)}`}</span> : "asset unknown"}<br />{j.page_id ? <span title={j.page_id}>{j.page_title ?? `page ${j.page_id.slice(0, 8)}`}</span> : "page unknown"}<br />{j.sales_agent_id ? <span title={j.sales_agent_id}>agent {j.sales_agent_id.slice(0, 8)}</span> : "agent unknown"}</span>,
            <span>{j.lead_stage}{j.outcome_events ? ` · ${j.outcome_events} outcome event${j.outcome_events === 1 ? "" : "s"}` : " · no outcome event"}</span>,
            `${j.sale_value === null ? "unknown" : Number(j.sale_value).toLocaleString()} / ${j.cash_collected === null ? "unknown" : Number(j.cash_collected).toLocaleString()}`,
          ])} />
      </section>

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

      {coverage && <section className="rounded-lg border border-border bg-card p-4 text-sm" aria-label="Attribution data coverage">
        <h2 className="font-semibold">Data coverage for this window</h2>
        <p className="mt-1">{coverage.sourced_leads} of {coverage.lead_rows} leads have a recorded source; {coverage.consented_leads} have recorded consent.</p>
        <p>{coverage.spend_rows} spend ledger entries{coverage.spend_currency ? ` in ${coverage.spend_currency}` : ""}; latest {coverage.latest_spend_date ?? "unknown"}.</p>
        <p>Paid metric dates: {coverage.paid_metric_days}; latest {coverage.latest_paid_metric_date ?? "unknown"}. These rows do not by themselves prove an account read.</p>
        <p>Current Meta account read: {coverage.latest_meta_read_at ? new Date(coverage.latest_meta_read_at).toLocaleString() : "none"}. Current Google Ads read: {coverage.latest_google_read_at ? new Date(coverage.latest_google_read_at).toLocaleString() : "none"}.</p>
        <BusinessProfileCoverage key={clientId} clientId={clientId} />
      </section>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">Cash collected · currency not shown</p>
          <p className="mt-1 text-2xl font-semibold text-card-foreground">
            {amount(funnel?.cash_collected ?? null)}
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
            {singleSpendCurrency ? spendMoney(funnel?.cost_per_lead ?? null, coverage?.spend_currency ?? null) : "—"}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">Return on spend</p>
          <p className="mt-1 text-2xl font-semibold text-card-foreground">
            —
          </p>
          <p className="mt-1 text-xs text-muted-foreground">This view does not expose lead cash currency coverage, so it cannot display a verified return against spend.</p>
        </div>
      </div>

      {/* Said once, plainly, rather than leaving four dashes to be read as
          "performed badly". */}
      {noSpendRows && (
        <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          No spend ledger entries are recorded in this window. Cost per lead and return on spend are unknown until spend coverage is checked; paid impressions are tracked separately. Connect Meta or Google Ads under Account → Integrations and reconcile provider results with the spend ledger. The recorded revenue above does not depend on an ads connection.
        </p>
      )}
      {mixedCurrencies && <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">Spend entries use more than one currency. Cost per lead is hidden until spend is converted to one reviewed currency; return on spend also needs a recorded cash currency.</p>}

      <div>
        <h2 className="mb-3 text-sm font-semibold text-foreground">
          What produced the revenue · all time
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
                amount(r.cash_collected),
              ])}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              {attributed === 0
                ? "No lead has recorded which asset it came from yet, so nothing can be attributed. A lead's source is set when it is created."
                : `${attributed} of ${top.length} shown assets have a lead attributed to them.`}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
