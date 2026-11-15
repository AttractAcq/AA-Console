import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { supabase } from "../../lib/supabase";

type Alert = {
  outcome_id: string;
  client_id: string;
  source_kind: string;
  outcome: string;
  occurred_at: string;
  owning_path: string;
};

/** Terminal attempts that need a person to inspect the owning source. */
export function ExternalExecutionAlerts({ clientId }: { clientId?: string }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [error, setError] = useState(false);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const refreshSequence = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    let query = supabase.from("client_external_outcomes_v6")
      .select("outcome_id,client_id,source_kind,outcome,occurred_at,owning_path")
      .in("outcome", ["refused", "uncertain", "failed", "abandoned"]);
    if (clientId) query = query.eq("client_id", clientId);
    const result = await query.order("occurred_at", { ascending: false }).limit(5);
    if (sequence !== refreshSequence.current) return;
    if (result.error) {
      setError(true);
      setLoadedScope(clientId ?? "all");
      return;
    }
    setAlerts((result.data ?? []).flatMap((row) =>
      row.outcome_id && row.client_id && row.source_kind && row.outcome
        && row.occurred_at && row.owning_path
        && row.owning_path.startsWith(`/clients/${row.client_id}/`)
        && (!clientId || row.client_id === clientId)
        ? [{ outcome_id: row.outcome_id, client_id: row.client_id,
          source_kind: row.source_kind, outcome: row.outcome,
          occurred_at: row.occurred_at, owning_path: row.owning_path }]
        : []));
    setError(false);
    setLoadedScope(clientId ?? "all");
  }, [clientId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { window.clearInterval(timer); refreshSequence.current += 1; };
  }, [refresh]);

  if (loadedScope !== (clientId ?? "all")) return null;
  if (!error && alerts.length === 0) return null;
  return <section aria-label="External execution alerts" className="rounded-xl border border-border bg-card p-4">
    <h3 className="text-sm font-semibold">External outcomes needing reconciliation</h3>
    {error ? <p role="alert" className="mt-2 text-xs text-destructive">Outcome alerts could not be loaded. Check the owning queues.</p>
      : <ul className="mt-2 space-y-2 text-sm">{alerts.map((alert) => <li key={alert.outcome_id}>
        <Link to={alert.owning_path} className="text-primary underline">
          {alert.source_kind.replaceAll("_", " ")} · {alert.outcome}
        </Link>
        <span className="text-muted-foreground"> · {new Date(alert.occurred_at).toLocaleString()}</span>
      </li>)}</ul>}
  </section>;
}
