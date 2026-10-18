import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import {
  compareOrganicAccount,
  comparePaid,
  priorWindow,
  type Comparison,
} from "../../lib/metricsCompare";

/**
 * Reads metrics_period_summary(), which is also what the commentary agent
 * reads. The aggregation rules live in that function rather than here so a
 * panel and the write-up beside it cannot disagree about a number.
 *
 * The window before this one is read too, and the deltas come from the
 * mirrored module the agent uses, for the same reason: a panel saying "+25%"
 * beside a write-up saying "+30%" gives a reader no way to know which to
 * believe, and both look authoritative.
 */

export interface PeriodSummary {
  window: { since: string; until: string };
  paid: {
    spend: number; impressions: number; clicks: number; conversions: number;
    days_covered: number; currency: string | null;
  };
  paid_campaigns: Array<{
    external_id: string; campaign_ref: string | null; target_role: string | null;
    mapped: boolean; spend: number; impressions: number; clicks: number;
    conversions: number; days_active: number;
  }>;
  organic_account: {
    /**
     * Null when no day carried one: the Instagram account endpoint has no
     * daily impressions series. "Not measured", not "measured as none".
     */
    impressions: number | null;
    impression_days: number;
    best_day_reach: number;
    engagements: number;
    days_covered: number;
  };
  organic_posts: Array<{
    external_id: string; ref_number: string | null; media_type: string | null;
    mapped: boolean; as_at: string; impressions: number | null;
    reach: number | null; engagements: number | null;
  }>;
  unmapped_rows: number;
  total_rows: number;
}

export const RANGES = [
  { id: "7", label: "Last 7 days", days: 7 },
  { id: "30", label: "Last 30 days", days: 30 },
  { id: "90", label: "Last 90 days", days: 90 },
];

export interface Trend {
  paid: Comparison;
  organic: Comparison;
  window: { since: string; until: string };
}

export function useMetrics(clientId: string | undefined, days: number) {
  const [summary, setSummary] = useState<PeriodSummary | null>(null);
  const [trend, setTrend] = useState<Trend | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const until = new Date();
    const since = new Date(until.getTime() - days * 86_400_000);
    const window = {
      since: since.toISOString().slice(0, 10),
      until: until.toISOString().slice(0, 10),
    };
    const prior = priorWindow(window.since, window.until);

    const [current, before] = await Promise.all([
      supabase.rpc("metrics_period_summary", {
        p_client_id: clientId,
        p_since: window.since,
        p_until: window.until,
      }),
      supabase.rpc("metrics_period_summary", {
        p_client_id: clientId,
        p_since: prior.since,
        p_until: prior.until,
      }),
    ]);

    if (current.error) {
      setError(current.error.message);
      setLoading(false);
      return;
    }
    setError(null);
    const now = current.data as unknown as PeriodSummary;
    setSummary(now);

    // A failure to read the earlier window loses the trend and nothing else.
    // The panel is still worth showing without one, and refusing to show it
    // would let a new feature break an old one.
    const earlier = before.error ? null : (before.data as unknown as PeriodSummary | null);
    setTrend(
      now && earlier && earlier.total_rows > 0
        ? {
            paid: comparePaid(now.paid, earlier.paid),
            organic: compareOrganicAccount(now.organic_account, earlier.organic_account),
            window: prior,
          }
        : null,
    );
    setLoading(false);
  }, [clientId, days]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { summary, trend, loading, error, refresh };
}

export const money = (value: number, currency: string | null): string =>
  `${currency ? `${currency} ` : ""}${Number(value ?? 0).toFixed(2)}`;

export const count = (value: number | null): string =>
  value === null || value === undefined ? "—" : Number(value).toLocaleString();

/** Derived rates are labelled everywhere they appear, never shown as measured. */
export const ratio = (numerator: number, denominator: number, digits = 2): string =>
  denominator > 0 ? (numerator / denominator).toFixed(digits) : "—";
