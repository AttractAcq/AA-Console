import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { ProductionAttemptComparison } from "../../components/ProductionAttemptComparison";

type Campaign = { id: string; name: string };
type RoutePackage = { id: string; campaign_id: string; route: string; version: number };
type Demand = {
  demand_id: string; campaign_id: string; route_package_id: string | null; piece_key: string;
  destination: string | null; media_type: string | null; content_format: string | null;
  attempts: number; produced: number; rejected: number; revised: number;
  workflow_accepted: number; human_approved: number;
};
type Work = { id: string; effective_state: string | null; effective_blocker: string | null };

/** Campaign requests share the same source records and attempt ledger as the
 * owning Content Production stages. This panel creates no campaign assets. */
export function CampaignProductionOverview() {
  const { clientId } = useParams<{ clientId: string }>();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [demand, setDemand] = useState<Demand[]>([]);
  const [packages, setPackages] = useState<Map<string, RoutePackage>>(new Map());
  const [work, setWork] = useState<Map<string, Work>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId) return;
    let active = true;
    const load = async () => {
      const recent = await supabase.from("client_campaigns")
        .select("id, name").eq("client_id", clientId)
        .not("built_at", "is", null).is("archived_at", null)
        .order("created_at", { ascending: false }).limit(8);
      if (!active) return;
      if (recent.error) { setError(recent.error.message); return; }
      const campaigns = (recent.data ?? []) as Campaign[];
      if (!campaigns.length) { setCampaigns([]); setDemand([]); setPackages(new Map()); setWork(new Map()); setError(null); return; }
      const ids = campaigns.map((campaign) => campaign.id);
      const routes = await supabase.from("campaign_route_packages_v6")
        .select("id, campaign_id, route, version")
        .eq("client_id", clientId).in("campaign_id", ids)
        .order("version", { ascending: false });
      if (!active) return;
      if (routes.error) { setError(routes.error.message); return; }
      const latest = new Map<string, RoutePackage>();
      for (const row of (routes.data ?? []) as RoutePackage[]) {
        const key = `${row.campaign_id}:${row.route}`;
        if (!latest.has(key)) latest.set(key, row);
      }
      const packageById = new Map([...latest.values()].map((row) => [row.id, row]));
      const packageIds = [...packageById.keys()];
      if (!packageIds.length) {
        setCampaigns(campaigns); setDemand([]); setPackages(new Map()); setWork(new Map()); setError(null); return;
      }
      const [counts, workResult] = await Promise.all([
        supabase.from("production_demand_counts_v8")
          .select("demand_id, campaign_id, route_package_id, piece_key, destination, media_type, content_format, attempts, produced, rejected, revised, workflow_accepted, human_approved")
          .eq("client_id", clientId).eq("demand_kind", "campaign").in("route_package_id", packageIds),
        supabase.from("delivery_work_effective_v6")
          .select("id, effective_state, effective_blocker")
          .eq("client_id", clientId).eq("owner_module", "content_production_factory")
          .in("route_package_id", packageIds),
      ]);
      if (!active) return;
      if (counts.error || workResult.error) {
        setError(counts.error?.message ?? workResult.error?.message ?? "Campaign production is unavailable.");
        return;
      }
      setCampaigns(campaigns);
      setDemand((counts.data ?? []) as Demand[]);
      setPackages(packageById);
      setWork(new Map(((workResult.data ?? []) as Work[]).map((row) => [row.id, row])));
      setError(null);
    };
    void load();
    return () => { active = false; };
  }, [clientId]);

  if (!clientId) return null;
  return <section className="mb-5 rounded-lg border border-border bg-card p-4" aria-label="Campaign production requests">
    <h2 className="font-semibold">Campaign production requests</h2>
    {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    {!error && !demand.length && <p className="mt-2 text-xs text-muted-foreground">
      {campaigns.length ? "No campaign assets have been requested yet. Generate Assets from an approved campaign plan." : "No planned campaigns for this client."}
    </p>}
    {campaigns.filter((campaign) => demand.some((row) => row.campaign_id === campaign.id))
      .map((campaign) => <div key={campaign.id} className="mt-3">
        <h3 className="text-sm font-medium"><Link className="text-brand-strong underline" to={`/clients/${clientId}/delivery/campaign-factory/${campaign.id}`}>{campaign.name}</Link></h3>
        <ul className="mt-1 space-y-2 text-xs text-muted-foreground">
          {demand.filter((row) => row.campaign_id === campaign.id).map((row) => {
            const item = work.get(row.demand_id);
            return <li key={row.demand_id}>
              {row.piece_key.replaceAll("_", " ")} · {packages.get(row.route_package_id ?? "")?.route ?? "route unknown"} v{packages.get(row.route_package_id ?? "")?.version ?? "?"} · {row.content_format ?? "format unknown"} · {row.media_type ?? "media unknown"} · {row.destination ?? "destination unknown"}
              {item?.effective_state ? ` · ${item.effective_state.replaceAll("_", " ")}` : ""}
              {` · 1 requested · ${row.produced} produced · ${row.rejected} failed or rejected attempts · ${row.revised} revised · ${row.workflow_accepted} passed workflow QA · ${row.human_approved} human approved`}
              {item?.effective_blocker && <span className="block text-destructive">{item.effective_blocker}</span>}
              <span className="block break-all">Request ID: <code>{row.demand_id}</code></span>
              <ProductionAttemptComparison clientId={clientId} demandId={row.demand_id} count={row.attempts} />
            </li>;
          })}
        </ul>
      </div>)}
  </section>;
}
