import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { DataTable } from "../../components/DataTable";
import { FilterPills } from "../../components/FilterPills";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef } from "../../components/forms/fields";
import { supabase } from "../../lib/supabase";
import { cn } from "../../lib/cn";
import {
  isMaturing,
  isUnavailable,
  money,
  ranges,
  showCost,
  showRatio,
  type Economics,
  type Shown,
} from "./metrics";

type ChannelRow = {
  channel: string;
  spend: number | null;
  leads: number;
  customers: number;
  revenue: number | null;
  cash_collected: number | null;
  cpl: number | null;
  cac: number | null;
  roas: number | null;
};

type CampaignRow = ChannelRow & { campaign_id: string | null; campaign_ref: string };

type CampaignOption = { id: string; campaign_ref: string };
type MoneyRow = { kind: "opportunity" | "sale" | "cash" | "spend"; currency: string | null; record_count: number; amount: number };

/** One headline figure, or the reason there isn't one. */
function Figure({ label, shown, hint }: { label: string; shown: Shown; hint?: string }) {
  const unavailable = isUnavailable(shown);
  return (
    <Panel title={label}>
      <p
        className={cn(
          "text-2xl font-semibold",
          unavailable ? "text-muted-foreground" : "text-card-foreground",
        )}
      >
        {unavailable ? "—" : shown.value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {unavailable ? shown.unavailable : (hint ?? "")}
      </p>
    </Panel>
  );
}

export function ClientEconomicsPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const windows = useMemo(() => ranges(), []);
  const [rangeId, setRangeId] = useState(windows[1]?.id ?? "30d");
  const [totals, setTotals] = useState<Economics | null>(null);
  const [byChannel, setByChannel] = useState<ChannelRow[]>([]);
  const [byCampaign, setByCampaign] = useState<CampaignRow[]>([]);
  const [moneyRows, setMoneyRows] = useState<MoneyRow[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  const [spendOpen, setSpendOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const range = windows.find((r) => r.id === rangeId) ?? windows[1] ?? windows[0];

  const refresh = useCallback(async () => {
    if (!clientId || !range) {
      setLoading(false);
      return;
    }
    const args = { p_client_id: clientId, p_since: range.since, p_until: range.until };
    const [t, ch, cp, mr, cam] = await Promise.all([
      supabase.rpc("client_economics", args),
      supabase.rpc("client_economics_by_channel", args),
      supabase.rpc("client_economics_by_campaign", args),
      supabase.rpc("client_money_currency_breakdown", args),
      supabase.from("campaigns").select("id, campaign_ref").eq("client_id", clientId),
    ]);
    const failure = t.error ?? ch.error ?? cp.error ?? mr.error ?? cam.error;
    setProblem(failure ? `Failed to load economics: ${failure.message}` : null);
    setTotals(((t.data as Economics[] | null) ?? [])[0] ?? null);
    setByChannel((ch.data as ChannelRow[] | null) ?? []);
    setByCampaign((cp.data as CampaignRow[] | null) ?? []);
    setMoneyRows((mr.data as MoneyRow[] | null) ?? []);
    setCampaigns((cam.data as CampaignOption[] | null) ?? []);
    setLoading(false);
  }, [clientId, range]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const fields: FieldDef[] = [
    { name: "amount", label: "Amount", kind: "number", required: true },
    { name: "currency", label: "Spend currency code", kind: "text", required: true, placeholder: "ZAR", hint: "Record the three-letter currency code actually spent; no conversion is applied." },
    { name: "spent_on", label: "Date spent", kind: "date", required: true },
    {
      name: "channel",
      label: "Channel",
      kind: "text",
      hint: "Match the lead source exactly — \"instagram\", \"facebook\" — or leave blank and it reports as unattributed.",
    },
    {
      name: "campaign_id",
      label: "Ad spend tracker (legacy)",
      kind: "select",
      options: [
        { value: "", label: "No ad spend tracker" },
        ...campaigns.map((c) => ({ value: c.id, label: c.campaign_ref })),
      ],
    },
    { name: "description", label: "What this was", kind: "text" },
  ];

  const cur = totals?.currency ?? null;
  const maturing = range ? isMaturing(range.until) : false;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterPills
          options={windows.map((r) => ({ id: r.id, label: r.label }))}
          activeId={rangeId}
          onChange={setRangeId}
        />
        <Button icon={Plus} onClick={() => setSpendOpen(true)}>
          Record Spend
        </Button>
      </div>

      {/* The window is the cohort, not the revenue period. Said once, plainly,
          because every figure below depends on reading it correctly. */}
      <p className="mb-4 text-xs text-muted-foreground">
        Cohort economics: spend recorded in this window, leads acquired in this window, and what
        those leads have produced so far.
        {maturing && " This cohort is still maturing — revenue and cash may rise as leads progress."}
      </p>

      {notice && (
        <p role="status" className="mb-4 text-sm text-brand-strong">
          {notice}
        </p>
      )}
      {problem && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {problem}
        </p>
      )}
      {totals?.mixed_currency && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          This window mixes more than one spend currency. Combined spend and return ratios are unavailable;
          review the separate currency amounts below.
        </p>
      )}
      <p className="mb-4 text-xs text-muted-foreground">Lead money totals require one recorded currency for every positive amount. Return multiples also require that currency to match spend. Review the currency breakdown below; return multiples remain hidden in this summary.</p>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : problem ? null : !totals ? (
        <p className="text-sm text-muted-foreground">No economics for this window.</p>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <Figure label="Spend" shown={totals.spend === null
              ? { unavailable: "Spend currencies are mixed; see the currency breakdown" }
              : { value: money(totals.spend, cur) }} hint="Recorded in this window" />
            <Figure
              label="Revenue"
              shown={
                totals.revenue === null
                  ? { unavailable: "Lead revenue currency coverage is incomplete" }
                  : totals.revenue > 0
                  ? { value: money(totals.revenue, null) }
                  : { unavailable: "No revenue from this cohort yet" }
              }
              hint="From leads acquired in this window · currency not shown"
            />
            <Figure
              label="Cash collected"
              shown={
                totals.cash_collected === null
                  ? { unavailable: "Lead cash currency coverage is incomplete" }
                  : totals.cash_collected > 0
                  ? { value: money(totals.cash_collected, null) }
                  : { unavailable: "No cash collected yet" }
              }
            />
            <Figure label="CAC" shown={totals.mixed_currency
              ? { unavailable: "Spend currencies are mixed" }
              : showCost(totals.cac, cur, "customers")} hint="Spend per customer" />
            <Figure
              label="ROAS"
              shown={totals.revenue === null
                ? { unavailable: "Lead revenue currency coverage is incomplete" }
                : totals.revenue > 0
                  ? { unavailable: "Lead revenue currency is not displayed here" }
                  : showRatio(totals.roas, totals.spend, totals.revenue)}
              hint="Revenue ÷ spend"
            />
            <Figure
              label="Cash ROAS"
              shown={totals.cash_collected === null
                ? { unavailable: "Lead cash currency coverage is incomplete" }
                : totals.cash_collected > 0
                  ? { unavailable: "Lead cash currency is not displayed here" }
                  : showRatio(totals.cash_roas, totals.spend, totals.cash_collected)}
              hint="Cash ÷ spend"
            />
          </div>

          <div>
            <h2 className="mb-3 text-sm font-semibold text-foreground">Money by recorded currency</h2>
            <DataTable
              columns={["Measure", "Currency", "Records", "Amount"]}
              emptyLabel="No positive lead money or spend recorded in this window"
              rows={moneyRows.map((row) => [
                { opportunity: "Opportunity", sale: "Sale", cash: "Cash", spend: "Spend" }[row.kind],
                row.currency ?? "Unverified",
                String(row.record_count),
                money(Number(row.amount), row.currency),
              ])}
            />
            <p className="mt-2 text-xs text-muted-foreground">Each currency is separate; unverified amounts have no assigned currency. Lead rows cover current, non-test leads acquired in this window. Archived leads are not included. Spend rows use their recorded spend date.</p>
          </div>

          <div>
            <h2 className="mb-3 text-sm font-semibold text-foreground">Funnel economics</h2>
            <DataTable
              columns={["Stage", "Count", "Cost each"]}
              emptyLabel="No funnel data in this window"
              rows={[
                ["Leads acquired", String(totals.leads), totals.mixed_currency ? { unavailable: "Spend currencies are mixed" } : showCost(totals.cpl, cur, "leads")],
                ["Qualified", String(totals.qualified_leads), totals.mixed_currency ? { unavailable: "Spend currencies are mixed" } : showCost(totals.cpql, cur, "qualified leads")],
                ["Appointments", String(totals.appointments), totals.mixed_currency ? { unavailable: "Spend currencies are mixed" } : showCost(totals.cpa, cur, "appointments")],
                ["Customers", String(totals.customers), totals.mixed_currency ? { unavailable: "Spend currencies are mixed" } : showCost(totals.cac, cur, "customers")],
              ].map(([stage, count, cost]) => [
                stage as string,
                count as string,
                isUnavailable(cost as Shown) ? (
                  <span className="text-muted-foreground" title={(cost as { unavailable: string }).unavailable}>
                    —
                  </span>
                ) : (
                  (cost as { value: string }).value
                ),
              ])}
            />
            {/* Counted by furthest stage reached, so a customer still counts as
                having had an appointment. Without this the cost-per-stage
                figures above would be overstated. */}
            <p className="mt-2 text-xs text-muted-foreground">
              Counted by the furthest stage each lead reached, not where it sits now.
            </p>
          </div>

          <div>
            <h2 className="mb-3 text-sm font-semibold text-foreground">By channel</h2>
            <DataTable
              columns={["Channel", "Spend", "Leads", "Customers", "Revenue (currency not shown)", "CPL", "ROAS"]}
              emptyLabel="No spend or leads in this window"
              rows={byChannel.map((r) => [
                r.channel,
                r.spend === null || totals.mixed_currency ? "—" : money(r.spend, cur),
                String(r.leads),
                String(r.customers),
                r.revenue === null ? "—" : money(Number(r.revenue), null),
                r.cpl === null || totals.mixed_currency ? "—" : money(Number(r.cpl), cur),
                "—",
              ])}
            />
          </div>

          <div>
            <h2 className="mb-3 text-sm font-semibold text-foreground">By ad spend tracker (legacy)</h2>
            <DataTable
              columns={["Ad spend tracker", "Spend", "Leads", "Customers", "Revenue (currency not shown)", "CPL", "ROAS"]}
              emptyLabel="No spend or leads in this window"
              rows={byCampaign.map((r) => [
                r.campaign_ref,
                r.spend === null || totals.mixed_currency ? "—" : money(r.spend, cur),
                String(r.leads),
                String(r.customers),
                r.revenue === null ? "—" : money(Number(r.revenue), null),
                r.cpl === null || totals.mixed_currency ? "—" : money(Number(r.cpl), cur),
                "—",
              ])}
            />
          </div>
        </div>
      )}

      <FormModal
        open={spendOpen}
        onClose={() => setSpendOpen(false)}
        title="Record Spend"
        draftKey={`spend:${clientId}`}
        intro="Acquisition spend for this client. This is the canonical ledger — a future Meta or Google sync writes into the same place."
        fields={fields}
        submitLabel="Record"
        onSubmit={async (v) => {
          if (!clientId) throw new Error("No client selected.");
          const currency = String(v.currency ?? "").trim().toUpperCase();
          if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Spend currency must be a three-letter code.");
          const { error } = await supabase.from("client_marketing_spend").insert({
            client_id: clientId,
            amount: Number(v.amount),
            currency,
            spent_on: v.spent_on as string,
            channel: ((v.channel as string) || "").trim() || null,
            campaign_id: (v.campaign_id as string) || null,
            description: ((v.description as string) || "").trim() || null,
            source: "manual",
          });
          if (error) throw new Error(error.message);
          setNotice("Spend recorded.");
        }}
        onSaved={refresh}
      />
    </div>
  );
}
