import { useEffect, useState } from "react";
import { useSignedPreviewPaths } from "../../lib/useSignedPreviewPaths";
import { supabase } from "../../lib/supabase";
import type { Database, Json } from "../../types/database";

type Candidate = Database["public"]["Tables"]["video_render_candidates"]["Row"];
type Check = { area: string; verdict: string; reason: string; at_sec?: number | null };

function object(value: Json | null): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function checks(value: Json | null): Check[] {
  const raw = object(value).checks;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is Check => item !== null && typeof item === "object"
    && !Array.isArray(item) && typeof item.area === "string"
    && typeof item.verdict === "string" && typeof item.reason === "string");
}

export function VideoCandidateReviewsPanel({ clientId, titles }: {
  clientId: string | undefined;
  titles: ReadonlyMap<string, string>;
}) {
  const [rows, setRows] = useState<Candidate[]>([]);
  const urls = useSignedPreviewPaths("client-media", rows.map((row) => row.render_path));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!clientId) { setLoading(false); return; }
    let active = true;
    void (async () => {
      try {
        const { data, error: queryError } = await supabase.from("video_render_candidates")
          .select("*").eq("client_id", clientId)
          .order("created_at", { ascending: false }).limit(50);
        if (queryError) throw queryError;
        const candidates = data ?? [];
        if (!active) return;
        setRows(candidates);
        setError(null);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [clientId]);

  return <section className="mb-6 space-y-3" aria-label="Video quality reviews">
    <div>
      <h2 className="text-sm font-semibold">Video quality reviews</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Every render remains inspectable, including rejected cuts. Internal checks screen the file before human approval.
      </p>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">Could not load video reviews: {error}</p>}
    {loading ? <p className="text-sm text-muted-foreground">Loading reviews…</p>
      : rows.length === 0 ? <p className="text-sm text-muted-foreground">No rendered candidates yet.</p>
        : rows.map((row) => {
          const probe = object(row.media_probe);
          const review = object(row.creative_review);
          const probeChecks = Array.isArray(probe.checks)
            ? probe.checks.filter((item): item is string => typeof item === "string") : [];
          const reviewChecks = checks(row.creative_review);
          return <article key={row.id} className="rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">
                {titles.get(row.asset_id) ?? "Reel"} · cut attempt {row.attempt}
              </h3>
              <span className="text-xs capitalize text-muted-foreground">Internal QA: {row.verdict}</span>
            </div>
            {urls.get(row.render_path)
              ? <video controls preload="metadata" className="mt-3 w-full max-w-sm rounded-md" src={urls.get(row.render_path)} />
              : <p className="mt-2 text-xs text-muted-foreground">Candidate preview unavailable.</p>}
            {row.rejection_reason && <p className="mt-2 text-sm text-destructive">{row.rejection_reason}</p>}
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer font-medium">Inspect media and creative checks</summary>
              <div className="mt-2 space-y-2">
                <p className="text-xs text-muted-foreground">
                  Media: {String(probe.result ?? "unknown")} · {String(probe.width ?? "?")}×{String(probe.height ?? "?")}
                  · {String(probe.duration_sec ?? "?")}s
                  {review.sampled_fps ? ` · creative review at ${String(review.sampled_fps)} fps` : ""}
                </p>
                {probeChecks.map((issue, index) => <p key={`${row.id}-probe-${index}`} className="text-xs text-destructive">{issue}</p>)}
                {review.summary && <p className="text-sm">{String(review.summary)}</p>}
                <ul className="space-y-1">
                  {reviewChecks.map((check) => <li key={check.area} className="text-xs">
                    <span className="font-medium">{check.area.replace(/_/g, " ")} · {check.verdict}</span>
                    {typeof check.at_sec === "number" ? ` · ${check.at_sec}s` : ""}: {check.reason}
                  </li>)}
                </ul>
              </div>
            </details>
          </article>;
        })}
  </section>;
}
