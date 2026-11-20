import { CollapsiblePanel } from "../../components/CollapsiblePanel";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

type Snapshot = Database["public"]["Tables"]["campaign_intelligence_snapshots"]["Row"];
type SourceRecord = { id: string; domain: string; title: string; body: string; updated_at: string };

function campaignLabel(row: Snapshot): string {
  if (row.acquisition_mode === "both") return `${row.paid_platform ?? "Paid"} + organic campaign`;
  if (row.acquisition_mode === "paid") return `${row.paid_platform ?? "Paid"} campaign`;
  if (row.acquisition_mode === "organic") return "Organic campaign";
  return "Campaign route not recorded";
}

export function CampaignInputsPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [rows, setRows] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (active: () => boolean) => {
    if (!clientId) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const { data, error: queryError } = await supabase.from("campaign_intelligence_snapshots")
        .select("*").eq("client_id", clientId)
        .order("captured_at", { ascending: false }).limit(50);
      if (!active()) return;
      if (queryError) throw queryError;
      setRows(data ?? []);
    } catch (cause) {
      if (!active()) return;
      setRows([]);
      setError(cause && typeof cause === "object" && "message" in cause
        ? String(cause.message) : "Snapshot read failed.");
    }
    setLoading(false);
  }, [clientId]);

  useEffect(() => {
    let active = true;
    void load(() => active);
    return () => { active = false; };
  }, [load]);

  return <div className="space-y-5">
    <div>
      <h2 className="text-xl font-semibold">Campaign input snapshots</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Each planning run freezes the client research it used, including source dates and missing inputs.
        A later edit to Intelligence OS does not silently change an existing plan.
      </p>
    </div>
    {error && <div role="alert" className="text-sm text-destructive">
      <p>Campaign input snapshots are unavailable: {error}</p>
      <button type="button" className="mt-1 underline" onClick={() => void load(() => true)}>Retry</button>
    </div>}
    {loading ? <p className="text-sm text-muted-foreground">Loading snapshots…</p>
      : error ? null
        : rows.length === 0 ? <p className="text-sm text-muted-foreground">No campaign has captured an intelligence snapshot yet.</p>
        : rows.map((row) => {
          const sources = Array.isArray(row.source_records)
            ? row.source_records as SourceRecord[] : [];
          return <CollapsiblePanel key={`${clientId}:${row.id}`} title={`${campaignLabel(row)} · ${new Date(row.captured_at).toLocaleString()}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 className="font-semibold">{campaignLabel(row)}</h3>
                <p className="mt-1 text-sm text-muted-foreground">Captured {new Date(row.captured_at).toLocaleString()} · {sources.length} source records</p>
              </div>
              <Link className="text-sm text-primary underline" to={`/clients/${clientId}/delivery/campaign-factory/${row.campaign_id}`}>
                View campaign
              </Link>
            </div>
            <p className="mt-3 text-sm">{row.brief}</p>
            <p className="mt-3 text-xs text-muted-foreground">Snapshot hash: <span className="font-mono">{row.snapshot_hash}</span></p>
            {row.missing_domains.length > 0 && <p className="mt-3 text-sm text-amber-700">
              Missing at capture: {row.missing_domains.join(", ")}
            </p>}
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer font-medium">View exact source material</summary>
              <div className="mt-3 space-y-3">
                <pre className="overflow-auto rounded-lg bg-muted p-3 text-xs">{JSON.stringify(row.business_context, null, 2)}</pre>
                {sources.map((source) => <CollapsiblePanel key={source.id} title={`${source.domain}: ${source.title}`}>
                  <p className="text-xs text-muted-foreground">Updated {new Date(source.updated_at).toLocaleString()}</p>
                  <p className="mt-2 whitespace-pre-wrap">{source.body}</p>
                </CollapsiblePanel>)}
              </div>
            </details>
          </CollapsiblePanel>;
        })}
  </div>;
}
