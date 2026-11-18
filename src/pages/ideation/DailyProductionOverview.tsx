import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { ProductionAttemptComparison } from "../../components/ProductionAttemptComparison";

type Package = { id: string; run_id: string; package_day: string; platform: string };
type Count = {
  demand_id: string; run_id: string; piece_key: string; destination: string | null;
  media_type: string | null; content_format: string | null;
  attempts: number; produced: number; rejected: number; revised: number;
  workflow_accepted: number; human_approved: number;
};

/** Latest daily requests, including work that has not produced an asset yet. */
export function DailyProductionOverview() {
  const { clientId } = useParams<{ clientId: string }>();
  const [packages, setPackages] = useState<Package[]>([]);
  const [counts, setCounts] = useState<Count[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId) return;
    let active = true;
    const load = async () => {
      const recent = await supabase.from("daily_packages")
        .select("id, run_id, package_day, platform")
        .eq("client_id", clientId).order("package_day", { ascending: false }).limit(7);
      if (!active) return;
      if (recent.error) { setError(recent.error.message); return; }
      const rows = (recent.data ?? []) as Package[];
      if (!rows.length) { setPackages([]); setCounts([]); setError(null); return; }
      const result = await supabase.from("production_demand_counts_v8")
        .select("demand_id, run_id, piece_key, destination, media_type, content_format, attempts, produced, rejected, revised, workflow_accepted, human_approved")
        .eq("client_id", clientId).eq("demand_kind", "daily")
        .in("run_id", rows.map((row) => row.run_id));
      if (!active) return;
      if (result.error) { setError(result.error.message); return; }
      setPackages(rows);
      setCounts((result.data ?? []) as Count[]);
      setError(null);
    };
    void load();
    return () => { active = false; };
  }, [clientId]);

  if (!clientId) return null;

  return <section className="mb-5 rounded-lg border border-border bg-card p-4" aria-label="Daily production requests">
    <h2 className="font-semibold">Daily production requests</h2>
    {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    {!error && !packages.length && <p className="mt-2 text-xs text-muted-foreground">No daily packages have been requested for this client.</p>}
    {packages.length > 0 && <div className="mt-3 space-y-3">{packages.map((pkg) =>
      <div key={pkg.id}>
        <h3 className="text-sm font-medium">{pkg.package_day} · {pkg.platform}</h3>
        <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
          {counts.filter((row) => row.run_id === pkg.run_id).map((row) =>
            <li key={row.demand_id}>
              {row.piece_key.replaceAll("_", " ")} · {row.content_format} · {row.media_type} · {row.destination} · 1 requested · {row.produced} produced · {row.rejected} failed or rejected attempts · {row.revised} revised · {row.workflow_accepted} passed workflow QA · {row.human_approved} human approved
              <ProductionAttemptComparison clientId={clientId}
                demandId={row.demand_id} count={row.attempts} />
            </li>)}
        </ul>
      </div>)}
    </div>}
  </section>;
}
