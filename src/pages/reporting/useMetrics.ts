import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";

/**
 * Reads metrics_period_summary(), which is also what the commentary agent
 * reads. The aggregation rules live in that function rather than here so a
 * panel and the write-up beside it cannot disagree about a number.
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
    impressions: number; best_day_reach: number; engagements: number; days_covered: number;
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

export function useMetrics(clientId: string | undefined, days: number) {
  const [summary, setSummary] = useState<PeriodSummary | null>(null);
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
    const { data, error: rpcError } = await supabase.rpc("metrics_period_summary", {
      p_client_id: clientId,
      p_since: since.toISOString().slice(0, 10),
      p_until: until.toISOString().slice(0, 10),
    });
    if (rpcError) setError(rpcError.message);
    else {
      setError(null);
      setSummary(data as unknown as PeriodSummary);
    }
    setLoading(false);
  }, [clientId, days]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { summary, loading, error, refresh };
}

export const money = (value: number, currency: string | null): string =>
  `${currency ? `${currency} ` : ""}${Number(value ?? 0).toFixed(2)}`;

export const count = (value: number | null): string =>
  value === null || value === undefined ? "—" : Number(value).toLocaleString();

/** Derived rates are labelled everywhere they appear, never shown as measured. */
export const ratio = (numerator: number, denominator: number, digits = 2): string =>
  denominator > 0 ? (numerator / denominator).toFixed(digits) : "—";
