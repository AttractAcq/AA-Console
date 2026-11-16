import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { enqueueAgentJob, supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

type Run = Database["public"]["Tables"]["google_ads_read_runs_v7"]["Row"];
type Campaign = Database["public"]["Tables"]["google_ads_campaign_reads_v7"]["Row"];
type Match = Database["public"]["Views"]["google_operator_google_match_v7"]["Row"];

export function GoogleAdsReadPanel({ clientId }: { clientId: string | undefined }) {
  const [run, setRun] = useState<Run | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [accountChanged, setAccountChanged] = useState(false);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    const [runs, matchRows, integration] = await Promise.all([
      supabase.from("google_ads_read_runs_v7").select("*")
        .eq("client_id",clientId).order("fetched_at",{ascending:false}).limit(1),
      supabase.from("google_operator_google_match_v7").select("*")
        .eq("client_id",clientId).limit(100),
      supabase.from("client_integrations").select("id,google_ads_customer_id,credential_secret_id")
        .eq("client_id",clientId).eq("provider","google_ads").maybeSingle(),
    ]);
    if (runs.error || matchRows.error || integration.error) throw new Error(
      runs.error?.message ?? matchRows.error?.message ?? integration.error?.message
      ?? "Google Ads reporting unavailable.");
    const prior = runs.data?.[0] ?? null;
    const latest = prior && prior.integration_id===integration.data?.id
      && prior.customer_id===integration.data?.google_ads_customer_id
      && prior.credential_secret_id===integration.data?.credential_secret_id ? prior : null;
    setAccountChanged(prior!==null && latest===null);
    setRun(latest);
    setMatches(matchRows.data ?? []);
    if (!latest) { setCampaigns([]); return; }
    const rows = await supabase.from("google_ads_campaign_reads_v7").select("*")
      .eq("run_id",latest.id).eq("client_id",clientId)
      .order("name",{ascending:true}).limit(5000);
    if (rows.error) throw new Error(rows.error.message);
    setCampaigns(rows.data ?? []);
  },[clientId]);

  useEffect(() => {
    const load = async () => { try { await refresh(); } catch (cause) { setError(String(cause)); } };
    void load();
  },[refresh]);

  async function queue() {
    if (!clientId || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const id = await enqueueAgentJob({agentKey:"google_ads_read",clientId});
      setNotice(`Read-only Google Ads job queued: ${id}. Refresh after it completes.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  const detail = campaigns.find((campaign) => campaign.external_campaign_id===selected);
  return <section className="space-y-3 rounded-lg border border-border bg-card p-4">
    <h3 className="font-semibold">Google Ads account inventory</h3>
    <p className="text-sm text-muted-foreground">This view reads the configured Google Ads customer. It never builds, activates or changes ads. Human-reported IDs only become observed when they appear in an account read.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-brand-strong">{notice}</p>}
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy || !clientId} onClick={() => void queue()}>Read Google Ads account</Button>
      <Button disabled={busy || !clientId} onClick={() => void refresh().catch((cause) => setError(String(cause)))}>Refresh view</Button>
    </div>
    {run ? <p className="text-xs text-muted-foreground">Customer {run.customer_id} · {run.currency} · {run.from_date} to {run.through_date} · fetched {new Date(run.fetched_at).toLocaleString()} · provider request {run.provider_request_id}</p>
      : <p className="text-sm text-muted-foreground">{accountChanged
        ? "The Google Ads account or credential changed after the last read. Inventory and metrics are unknown until a new read."
        : "No verified account read is recorded yet. Inventory and metrics are unknown."}</p>}
    {matches.length > 0 && <div className="space-y-1 text-xs">
      <h4 className="font-medium">Operator ID reconciliation</h4>
      {matches.map((match) => <p key={match.bundle_id}>Bundle {match.bundle_id?.slice(0,8) ?? "unknown"} · reported {match.reported_campaign_id ?? "none"} · {(match.match_state ?? "unknown").replaceAll("_"," ")}</p>)}
    </div>}
    {run && <div className="grid gap-2 sm:grid-cols-2">
      <div className="space-y-1">
        {campaigns.length===0 && <p className="text-sm">The account returned no campaigns.</p>}
        {campaigns.map((campaign) => <button key={campaign.external_campaign_id} type="button"
          className="block w-full rounded border border-border p-2 text-left text-sm hover:bg-muted"
          onClick={() => setSelected(campaign.external_campaign_id)}>
          {campaign.name} · {campaign.status} · {campaign.external_campaign_id}
        </button>)}
      </div>
      {detail && <dl className="grid content-start gap-2 rounded border border-border p-3 text-sm">
        <div><dt className="text-muted-foreground">Campaign</dt><dd>{detail.name} · {detail.channel}</dd></div>
        <div><dt className="text-muted-foreground">Status</dt><dd>{detail.status}</dd></div>
        <div><dt className="text-muted-foreground">Impressions</dt><dd>{detail.impressions}</dd></div>
        <div><dt className="text-muted-foreground">Clicks</dt><dd>{detail.clicks}</dd></div>
        <div><dt className="text-muted-foreground">Spend in period</dt><dd>{(Number(detail.cost_micros)/1_000_000).toFixed(2)} {run.currency}</dd></div>
        <div><dt className="text-muted-foreground">Conversions</dt><dd>{detail.conversions}</dd></div>
      </dl>}
    </div>}
  </section>;
}
