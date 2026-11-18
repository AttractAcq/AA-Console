import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useSignedPreviewPaths } from "../lib/useSignedPreviewPaths";

type Attempt = {
  attempt_id: string;
  attempt_kind: string;
  attempt_status: string;
  asset_id: string | null;
  cost_usd: number | null;
  created_at: string;
  revised: boolean;
  human_review_status: string | null;
  accepted_workflow_output: boolean;
};
type Asset = {
  id: string;
  title: string | null;
  media_type: string;
  storage_path: string;
  render_path: string | null;
};

/** Read-only comparison of exact attempts; preview URLs are signed only while open. */
export function ProductionAttemptComparison({ clientId, demandId, count }: {
  clientId: string; demandId: string; count: number;
}) {
  const [open, setOpen] = useState(false);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urls = useSignedPreviewPaths("client-media",
    assets.map((asset) => asset.render_path || asset.storage_path), open);
  const byAsset = new Map(assets.map((asset) => [asset.id, asset]));

  useEffect(() => {
    if (!open) return;
    let active = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      const result = await supabase.from("production_attempts_v8")
        .select("attempt_id, attempt_kind, attempt_status, asset_id, cost_usd, created_at, revised, human_review_status, accepted_workflow_output")
        .eq("client_id", clientId).eq("demand_id", demandId)
        .order("created_at", { ascending: true });
      if (!active) return;
      if (result.error) { setError(result.error.message); setLoading(false); return; }
      const rows = (result.data ?? []) as Attempt[];
      const ids = [...new Set(rows.flatMap((row) => row.asset_id ? [row.asset_id] : []))];
      const assetResult = ids.length ? await supabase.from("client_media_assets")
        .select("id, title, media_type, storage_path, render_path")
        .eq("client_id", clientId).in("id", ids)
        : { data: [], error: null };
      if (!active) return;
      if (assetResult.error) { setError(assetResult.error.message); setLoading(false); return; }
      setAttempts(rows);
      setAssets((assetResult.data ?? []) as Asset[]);
      setLoading(false);
    };
    void load();
    return () => { active = false; };
  }, [open, clientId, demandId, count]);

  if (count < 1) return null;
  return <div className="mt-2 text-xs">
    <button type="button" className="rounded-md border border-border px-2 py-1 hover:bg-accent"
      aria-expanded={open} onClick={() => setOpen(!open)}>Compare attempts</button>
    {open && <div className="mt-2 space-y-2" aria-label="Production attempts">
      {loading && <p>Loading attempts…</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {!loading && !error && attempts.length === 0 && <p>No attempts are readable for this request.</p>}
      {!loading && !error && attempts.map((attempt) => {
        const asset = byAsset.get(attempt.asset_id ?? "");
        const path = asset?.render_path || asset?.storage_path;
        const url = path ? urls.get(path) : undefined;
        return <div key={attempt.attempt_id} className="rounded-md border border-border p-2">
          <p>{attempt.attempt_kind.replaceAll("_", " ")} · {attempt.attempt_status}
            {attempt.revised ? " · revision" : ""} · {new Date(attempt.created_at).toLocaleString()}</p>
          <p>Cost {attempt.cost_usd === null ? "unknown" : `$${Number(attempt.cost_usd).toFixed(2)}`}
            {" · "}Human review {attempt.human_review_status ?? "not available"}
            {" · "}Workflow QA {attempt.accepted_workflow_output ? "accepted" : "not accepted"}</p>
          {asset && <div className="mt-2">
            <p>{asset.title ?? "Untitled output"} · {asset.media_type}</p>
            {!url && <p>Preview unavailable</p>}
            {url && asset.media_type === "image" &&
              <img src={url} alt={asset.title ?? "Production candidate"} className="mt-1 max-h-48 max-w-full rounded" />}
            {url && asset.media_type === "video" &&
              <video src={url} controls preload="none" className="mt-1 max-h-48 max-w-full rounded" />}
            {url && asset.media_type === "text" &&
              <a href={url} target="_blank" rel="noreferrer" className="underline">Open text output</a>}
          </div>}
          {!asset && <p>No output asset</p>}
        </div>;
      })}
    </div>}
  </div>;
}
