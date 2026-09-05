import { useState } from "react";
import { useParams } from "react-router-dom";
import { Panel } from "../../components/Panel";
import { DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { RangePicker } from "./RangePicker";
import { RANGES, count, money, ratio, useMetrics } from "./useMetrics";

export function PaidReportingPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [range, setRange] = useState("30");
  const days = RANGES.find((r) => r.id === range)?.days ?? 30;
  const { summary, loading, error } = useMetrics(clientId, days);

  if (loading) return <p className="text-sm text-muted-foreground">Loading metrics…</p>;
  if (error) {
    return <p role="alert" className="text-sm text-destructive">{error}</p>;
  }

  const paid = summary?.paid;
  const campaigns = summary?.paid_campaigns ?? [];
  const currency = paid?.currency ?? null;

  if (!paid || paid.days_covered === 0) {
    return (
      <div>
        <RangePicker value={range} onChange={setRange} />
        <EmptyState label="No paid metrics ingested for this period. Connect a Meta integration in Account → Integrations and turn on the daily sync." />
      </div>
    );
  }

  return (
    <div>
      <RangePicker
        value={range}
        onChange={setRange}
        note={`${paid.days_covered} day(s) with data in this window`}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Panel title="Spend">
          <p className="text-2xl font-semibold text-card-foreground">{money(paid.spend, currency)}</p>
        </Panel>
        <Panel title="Impressions">
          <p className="text-2xl font-semibold text-card-foreground">{count(paid.impressions)}</p>
        </Panel>
        <Panel title="Clicks">
          <p className="text-2xl font-semibold text-card-foreground">{count(paid.clicks)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {paid.impressions > 0
              ? `${((paid.clicks / paid.impressions) * 100).toFixed(2)}% of impressions`
              : ""}
          </p>
        </Panel>
        <Panel title="Conversions">
          <p className="text-2xl font-semibold text-card-foreground">{count(paid.conversions)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {paid.conversions > 0
              ? `${money(Number(ratio(paid.spend, paid.conversions)), currency)} each`
              : "None recorded"}
          </p>
        </Panel>
      </div>

      <h2 className="mb-3 text-sm font-semibold text-foreground">By campaign</h2>
      <DataTable
        columns={["Campaign", "Spend", "Impressions", "Clicks", "Conversions", "Cost per conv.", "Days"]}
        emptyLabel="No campaigns in this period"
        rows={campaigns.map((c) => [
          c.campaign_ref ? (
            <span key="n">
              {c.campaign_ref}
              {c.target_role && (
                <span className="block text-xs text-muted-foreground">{c.target_role}</span>
              )}
            </span>
          ) : (
            // Real numbers for something nobody created here. Saying so is
            // more useful than hiding the row or inventing a name.
            <span key="n" className="text-muted-foreground">
              Not in the console
              <span className="block text-xs">{c.external_id}</span>
            </span>
          ),
          money(c.spend, currency),
          count(c.impressions),
          count(c.clicks),
          count(c.conversions),
          c.conversions > 0 ? money(Number(ratio(c.spend, c.conversions)), currency) : "—",
          String(c.days_active),
        ])}
      />

      <p className="mt-3 text-xs text-muted-foreground">
        Figures are the sum of daily rows across the window. Cost per click and cost per conversion
        are derived from those totals.
      </p>
    </div>
  );
}
