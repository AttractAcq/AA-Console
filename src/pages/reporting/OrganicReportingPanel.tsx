import { useState } from "react";
import { useParams } from "react-router-dom";
import { Panel } from "../../components/Panel";
import { DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { RangePicker } from "./RangePicker";
import { RANGES, count, useMetrics } from "./useMetrics";

export function OrganicReportingPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [range, setRange] = useState("30");
  const days = RANGES.find((r) => r.id === range)?.days ?? 30;
  const { summary, loading, error } = useMetrics(clientId, days);

  if (loading) return <p className="text-sm text-muted-foreground">Loading metrics…</p>;
  if (error) {
    return <p role="alert" className="text-sm text-destructive">{error}</p>;
  }

  const account = summary?.organic_account;
  const posts = summary?.organic_posts ?? [];

  if ((!account || account.days_covered === 0) && posts.length === 0) {
    return (
      <div>
        <RangePicker value={range} onChange={setRange} />
        <EmptyState label="No organic metrics ingested for this period. Connect an Instagram integration in Account → Integrations and turn on the daily sync." />
      </div>
    );
  }

  return (
    <div>
      <RangePicker
        value={range}
        onChange={setRange}
        note={`${account?.days_covered ?? 0} day(s) with data in this window`}
      />

      {account && account.days_covered > 0 && (
        <div className="mb-6 grid gap-4 sm:grid-cols-3">
          <Panel title="Impressions">
            <p className="text-2xl font-semibold text-card-foreground">{count(account.impressions)}</p>
            <p className="mt-1 text-xs text-muted-foreground">Summed across the period</p>
          </Panel>
          <Panel title="Best day for reach">
            <p className="text-2xl font-semibold text-card-foreground">
              {count(account.best_day_reach)}
            </p>
            {/* Adding daily reach would count the same person once per day
                they saw you, so the best single day is the honest summary. */}
            <p className="mt-1 text-xs text-muted-foreground">
              Reach counts people, so it is never summed across days
            </p>
          </Panel>
          <Panel title="Interactions">
            <p className="text-2xl font-semibold text-card-foreground">{count(account.engagements)}</p>
          </Panel>
        </div>
      )}

      <h2 className="mb-3 text-sm font-semibold text-foreground">Posts</h2>
      <DataTable
        columns={["Post", "Impressions", "Reach", "Interactions", "As at"]}
        emptyLabel="No post metrics in this period"
        rows={posts.map((p) => [
          p.ref_number ? (
            <span key="n">
              {p.ref_number}
              {p.media_type && (
                <span className="block text-xs capitalize text-muted-foreground">{p.media_type}</span>
              )}
            </span>
          ) : (
            <span key="n" className="text-muted-foreground">
              Not in the console
              <span className="block text-xs">{p.external_id}</span>
            </span>
          ),
          count(p.impressions),
          count(p.reach),
          count(p.engagements),
          p.as_at,
        ])}
      />

      <p className="mt-3 text-xs text-muted-foreground">
        Post figures are lifetime totals for each post as at the date shown, not what it earned
        during this window — the platform reports them that way. They are not comparable to the
        account figures above and should not be added together.
      </p>
    </div>
  );
}
