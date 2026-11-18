import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { enqueueAgentJob, supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

type Run = Database["public"]["Tables"]["meta_ads_read_runs_v7"]["Row"];
type Campaign = Database["public"]["Tables"]["meta_ads_campaign_reads_v7"]["Row"];
type Ad = Database["public"]["Tables"]["meta_ads_ad_reads_v7"]["Row"];
type Match = Database["public"]["Views"]["meta_operator_account_match_v7"]["Row"];

function actionLabels(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "No actions returned";
  return value.map((item) => {
    if (!item || typeof item !== "object") return "Unknown";
    const row = item as Record<string, unknown>;
    return `${String(row.action_type ?? "Unknown")}: ${String(row.value ?? "unknown")}`;
  }).join(" · ");
}

export function MetaAdsReadPanel({ clientId }: { clientId: string | undefined }) {
  return <MetaAdsReadPanelForClient key={clientId ?? "no-client"} clientId={clientId} />;
}

function MetaAdsReadPanelForClient({ clientId }: { clientId: string | undefined }) {
  const [run, setRun] = useState<Run | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [ads, setAds] = useState<Ad[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [selectedCampaign, setSelectedCampaign] = useState<string | null>(null);
  const [selectedAd, setSelectedAd] = useState<string | null>(null);
  const [accountChanged, setAccountChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    const [runs, integration, matchRows] = await Promise.all([
      supabase.from("meta_ads_read_runs_v7").select("*")
        .eq("client_id", clientId).order("fetched_at", { ascending: false }).limit(1),
      supabase.from("client_integrations").select("id,ad_account_id,credential_secret_id")
        .eq("client_id", clientId).eq("provider", "meta").maybeSingle(),
      supabase.from("meta_operator_account_match_v7").select("*")
        .eq("client_id", clientId).limit(100),
    ]);
    if (runs.error || integration.error || matchRows.error) throw new Error(
      runs.error?.message ?? integration.error?.message ?? matchRows.error?.message
      ?? "Meta account reporting unavailable.");
    const prior = runs.data?.[0] ?? null;
    const latest = prior && prior.integration_id === integration.data?.id
      && prior.account_id === integration.data?.ad_account_id
      && prior.credential_secret_id === integration.data?.credential_secret_id ? prior : null;
    setAccountChanged(prior !== null && latest === null);
    setRun(latest); setMatches(matchRows.data ?? []);
    if (!latest) { setCampaigns([]); setAds([]); setSelectedCampaign(null); setSelectedAd(null); return; }
    const [campaignRows, adRows] = await Promise.all([
      supabase.from("meta_ads_campaign_reads_v7").select("*")
        .eq("run_id", latest.id).eq("client_id", clientId).order("name", { ascending: true }).limit(5000),
      supabase.from("meta_ads_ad_reads_v7").select("*")
        .eq("run_id", latest.id).eq("client_id", clientId).order("name", { ascending: true }).limit(5000),
    ]);
    if (campaignRows.error || adRows.error) throw new Error(
      campaignRows.error?.message ?? adRows.error?.message);
    setCampaigns(campaignRows.data ?? []); setAds(adRows.data ?? []);
  }, [clientId]);

  useEffect(() => {
    void refresh().catch((cause) => setError(String(cause)));
  }, [refresh]);

  async function queue() {
    if (!clientId || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const id = await enqueueAgentJob({ agentKey: "meta_ads_read", clientId });
      setNotice(`Read-only Meta Ads job queued: ${id}. Refresh after it completes.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  const campaign = campaigns.find((item) => item.external_campaign_id === selectedCampaign);
  const ad = ads.find((item) => item.external_ad_id === selectedAd);
  return <section className="space-y-3 rounded-lg border border-border bg-card p-4">
    <h3 className="font-semibold">Meta Ads account inventory</h3>
    <p className="text-sm text-muted-foreground">Provider read of the configured ad account. This view does not build, activate or change ads. Human-reported IDs are observed only if they appear in this account snapshot.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-brand-strong">{notice}</p>}
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy || !clientId} onClick={() => void queue()}>Read Meta Ads account</Button>
      <Button disabled={busy || !clientId} onClick={() => void refresh().catch((cause) => setError(String(cause)))}>Refresh view</Button>
    </div>
    {run ? <p className="text-xs text-muted-foreground">Account {run.account_id} · {run.currency} · {run.from_date} to {run.through_date} · fetched {new Date(run.fetched_at).toLocaleString()}</p>
      : <p className="text-sm text-muted-foreground">{accountChanged
        ? "The Meta ad account or credential changed after the last read. Inventory and metrics are unknown until a new read."
        : "No verified account read is recorded yet. Inventory and metrics are unknown."}</p>}
    {matches.length > 0 && <div className="space-y-1 text-xs">
      <h4 className="font-medium">Operator ID reconciliation</h4>
      {matches.map((match) => <p key={match.bundle_id}>Bundle {match.bundle_id?.slice(0, 8) ?? "unknown"} · reported campaign {match.reported_campaign_id ?? "none"} · {(match.match_state ?? "unknown").replaceAll("_", " ")}</p>)}
    </div>}
    {run && <div className="grid gap-3 lg:grid-cols-2">
      <div className="space-y-1"><h4 className="font-medium">Campaigns ({campaigns.length})</h4>
        {campaigns.length === 0 && <p className="text-sm">The account returned no campaigns.</p>}
        {campaigns.map((item) => <button key={item.external_campaign_id} type="button"
          className="block w-full rounded border border-border p-2 text-left text-sm hover:bg-muted"
          onClick={() => setSelectedCampaign(item.external_campaign_id)}>
          {item.name} · {item.effective_status} · {item.external_campaign_id}
        </button>)}
        {campaign && <dl className="grid gap-1 rounded border border-border p-3 text-sm">
          <div><dt>Status</dt><dd>{campaign.status} · effective {campaign.effective_status}</dd></div>
          {campaign.metrics_observed ? <>
            <div><dt>Impressions</dt><dd>{campaign.impressions}</dd></div>
            <div><dt>Clicks</dt><dd>{campaign.clicks}</dd></div>
            <div><dt>Spend in period</dt><dd>{Number(campaign.spend).toFixed(2)} {run.currency}</dd></div>
            <div><dt>Actions by type</dt><dd>{actionLabels(campaign.actions)}</dd></div>
          </> : <div><dt>Period metrics</dt><dd>Unknown — no provider metrics row returned.</dd></div>}
        </dl>}
      </div>
      <div className="space-y-1"><h4 className="font-medium">Ads ({ads.length})</h4>
        {ads.length === 0 && <p className="text-sm">The account returned no ads.</p>}
        {ads.map((item) => <button key={item.external_ad_id} type="button"
          className="block w-full rounded border border-border p-2 text-left text-sm hover:bg-muted"
          onClick={() => setSelectedAd(item.external_ad_id)}>
          {item.name} · {item.effective_status} · {item.external_ad_id}
        </button>)}
        {ad && <dl className="grid gap-1 rounded border border-border p-3 text-sm">
          <div><dt>Campaign / ad set</dt><dd>{ad.external_campaign_id} / {ad.external_adset_id}</dd></div>
          <div><dt>Status</dt><dd>{ad.status} · effective {ad.effective_status}</dd></div>
          <div><dt>Creative</dt><dd>{ad.creative_name ?? "None returned"} {ad.creative_id ?? ""}</dd></div>
          {ad.metrics_observed ? <>
            <div><dt>Impressions</dt><dd>{ad.impressions}</dd></div>
            <div><dt>Clicks</dt><dd>{ad.clicks}</dd></div>
            <div><dt>Spend in period</dt><dd>{Number(ad.spend).toFixed(2)} {run.currency}</dd></div>
            <div><dt>Actions by type</dt><dd>{actionLabels(ad.actions)}</dd></div>
          </> : <div><dt>Period metrics</dt><dd>Unknown — no provider metrics row returned.</dd></div>}
        </dl>}
      </div>
    </div>}
  </section>;
}
