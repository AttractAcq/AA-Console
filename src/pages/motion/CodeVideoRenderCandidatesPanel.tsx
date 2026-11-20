import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { useSignedPreviewPaths } from "../../lib/useSignedPreviewPaths";
import type { Database, Json } from "../../types/database";

type Candidate = Database["public"]["Tables"]["video_project_render_candidates_v1"]["Row"];

function object(value: Json | null): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function CodeVideoRenderCandidatesPanel({ clientId, titles }: {
  clientId: string | undefined;
  titles: ReadonlyMap<string, string>;
}) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const urls = useSignedPreviewPaths("client-media", candidates.map((row) => row.storage_path));

  useEffect(() => {
    if (!clientId) { setCandidates([]); setLoading(false); return; }
    let active = true;
    setLoading(true);
    void (async () => {
      const { data, error: queryError } = await supabase
        .from("video_project_render_candidates_v1")
        .select("*").eq("client_id", clientId)
        .order("created_at", { ascending: false }).limit(50);
      if (!active) return;
      setCandidates(data ?? []);
      setError(queryError?.message ?? null);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [clientId]);

  return <section aria-label="Code-video render candidates" className="space-y-2">
    <h3 className="text-xs font-semibold">Render candidates</h3>
    <p className="text-xs text-muted-foreground">These files are internal candidates. A passed media probe is not creative or human approval.</p>
    {loading && <p className="text-xs text-muted-foreground">Loading render candidates…</p>}
    {error && <p role="alert" className="text-xs text-destructive">Could not load render candidates: {error}</p>}
    {!loading && !error && candidates.length === 0 && <p className="text-xs text-muted-foreground">No render candidates yet.</p>}
    {candidates.map((row) => {
      const probe = object(row.media_probe);
      const review = object(row.creative_review);
      const url = urls.get(row.storage_path);
      return <article key={row.id} className="rounded-md border border-border p-3 text-xs">
        <h4 className="font-medium">{titles.get(row.project_id) ?? "Video project"} · {row.aspect} · IR v{row.ir_version}</h4>
        <p className="text-muted-foreground">Media probe: {row.probe_result} · Creative review: {row.verdict}</p>
        <p className="text-muted-foreground">{String(probe.width ?? "?")}×{String(probe.height ?? "?")} · {String(probe.duration_sec ?? "?")}s · {(row.file_bytes / 1_000_000).toFixed(1)} MB</p>
        {url ? <video controls preload="metadata" className="mt-2 w-full max-w-md rounded-md" src={url} />
          : <p className="text-muted-foreground">Private preview unavailable.</p>}
        {row.rejection_reason && <p className="mt-2 text-destructive">{row.rejection_reason}</p>}
        {typeof review.summary === "string" && <p className="mt-2">{review.summary}</p>}
        <details className="mt-2"><summary className="cursor-pointer">Exact candidate receipt</summary>
          <p className="break-all">SHA-256: {row.file_sha256}</p>
          <p className="break-all">Attempt: {row.attempt_id}</p>
          <p>Filed: {row.created_at}</p>
        </details>
      </article>;
    })}
  </section>;
}
