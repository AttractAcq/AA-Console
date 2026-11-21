import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { useSignedPreviewPaths } from "../../lib/useSignedPreviewPaths";
import type { Database, Json } from "../../types/database";

type Candidate = Database["public"]["Tables"]["video_project_render_candidates_v1"]["Row"];

function object(value: Json | null): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

type Check = { area: string; verdict: string; reason: string;
  at_sec: number | null };
function checks(value: Json | undefined): Check[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Check => item !== null
    && typeof item === "object" && !Array.isArray(item)
    && typeof item.area === "string"
    && typeof item.verdict === "string"
    && typeof item.reason === "string");
}

export function CodeVideoRenderCandidatesPanel({ clientId, titles, projectIds }: {
  clientId: string | undefined;
  titles: ReadonlyMap<string, string>;
  projectIds?: readonly string[];
}) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const urls = useSignedPreviewPaths("client-media", candidates.map((row) => row.storage_path));

  useEffect(() => {
    if (!clientId || projectIds?.length === 0) { setCandidates([]); setLoading(false); return; }
    let active = true;
    setLoading(true);
    void (async () => {
      const query = supabase
        .from("video_project_render_candidates_v1")
        .select("*").eq("client_id", clientId);
      const { data, error: queryError } = await (projectIds
        ? query.in("project_id", [...projectIds]) : query)
        .order("created_at", { ascending: false }).limit(50);
      if (!active) return;
      setCandidates(data ?? []);
      setError(queryError?.message ?? null);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [clientId, projectIds]);

  return <section aria-label="Code-video render candidates" className="space-y-2">
    <h3 className="text-xs font-semibold">Render candidates</h3>
    <p className="text-xs text-muted-foreground">These files are internal candidates. A passed media probe is not creative or human approval.</p>
    {loading && <p className="text-xs text-muted-foreground">Loading render candidates…</p>}
    {error && <p role="alert" className="text-xs text-destructive">Could not load render candidates: {error}</p>}
    {!loading && !error && candidates.length === 0 && <p className="text-xs text-muted-foreground">No render candidates yet.</p>}
    {candidates.map((row) => {
      const probe = object(row.media_probe);
      const review = object(row.creative_review);
      const creativeChecks = checks(review.checks);
      const probeChecks = Array.isArray(probe.checks)
        ? probe.checks.filter((issue): issue is string => typeof issue === "string") : [];
      const segments = Array.isArray(review.segments) ? review.segments : [];
      const url = urls.get(row.storage_path);
      return <article key={row.id} className="rounded-md border border-border p-3 text-xs">
        <h4 className="font-medium">{titles.get(row.project_id) ?? "Video project"} · {row.aspect} · IR v{row.ir_version}</h4>
        <p className="text-muted-foreground">Media probe: {row.probe_result} · Creative review: {row.verdict}</p>
        <p className="text-muted-foreground">{String(probe.width ?? "?")}×{String(probe.height ?? "?")} · {String(probe.duration_sec ?? "?")}s · {(row.file_bytes / 1_000_000).toFixed(1)} MB</p>
        {url ? <video controls preload="metadata" className="mt-2 w-full max-w-md rounded-md" src={url} />
          : <p className="text-muted-foreground">Private preview unavailable.</p>}
        {row.rejection_reason && <p className="mt-2 text-destructive">{row.rejection_reason}</p>}
        {typeof review.summary === "string" && <p className="mt-2">{review.summary}</p>}
        <details className="mt-2"><summary className="cursor-pointer">Inspect media and creative checks</summary>
          <div className="mt-2 space-y-1">
            <p>Audio: {probe.has_audio === true ? "present" : "unknown or absent"}
              {typeof probe.audio_integrated_lufs === "number"
                ? ` · ${probe.audio_integrated_lufs} LUFS` : ""}
              {typeof probe.audio_true_peak_dbfs === "number"
                ? ` · true peak ${probe.audio_true_peak_dbfs} dBFS` : ""}</p>
            {probeChecks.map((issue, index) => <p key={`${row.id}-probe-${index}`}
              className="text-destructive">Media: {issue}</p>)}
            {creativeChecks.map((check) => <p key={`${row.id}-${check.area}`}
              className={check.verdict === "fail" ? "text-destructive" : undefined}>
              {check.area.replace(/_/g, " ")} · {check.verdict}
              {typeof check.at_sec === "number" ? ` at ${check.at_sec}s` : ""}: {check.reason}</p>)}
            {segments.length > 0 && <p>{segments.length} sampled review segments
              {typeof review.sampled_frames === "number"
                ? ` · ${review.sampled_frames} frames` : ""}</p>}
            {segments.map((segment, index) => {
              const item = object(segment as Json);
              return <p key={`${row.id}-segment-${index}`}>Segment {index + 1}:
                {typeof item.first_sec === "number" ? ` ${item.first_sec}s` : ""}
                {typeof item.last_sec === "number" ? `–${item.last_sec}s` : ""}
                {typeof item.summary === "string" ? ` · ${item.summary}` : ""}</p>;
            })}
            {row.verdict === "pending" && <p>Creative review has not been filed.</p>}
          </div>
        </details>
        <details className="mt-2"><summary className="cursor-pointer">Exact candidate receipt</summary>
          <p className="break-all">SHA-256: {row.file_sha256}</p>
          <p className="break-all">Attempt: {row.attempt_id}</p>
          <p>Filed: {row.created_at}</p>
        </details>
      </article>;
    })}
  </section>;
}
