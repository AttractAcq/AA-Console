import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { signPaths } from "../../lib/media";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

type Platform = Database["public"]["Enums"]["post_platform"];
type Video = { id: string; title: string | null; storage_path: string;
  render_path: string | null; edit_stage: string; review_status: string };
type Candidate = { kind: "quote_image" | "short_clip"; title: string; reason: string;
  start_sec: number; end_sec: number; exact_quote: string };
type Request = { id: string; source_asset_id: string; direction: string;
  status: string; candidates: unknown; error: string | null; created_at: string };
type Derivative = { request_id: string; candidate_index: number; target_platform: Platform;
  idea_id: string; reentry_stage: string };
const PLATFORMS: Platform[] = ["instagram", "facebook", "tiktok", "linkedin", "youtube"];

export function VideoRepurposePanel({ clientId }: { clientId: string | undefined }) {
  const [videos, setVideos] = useState<Video[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [derivatives, setDerivatives] = useState<Derivative[]>([]);
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map());
  const [sourceId, setSourceId] = useState("");
  const [direction, setDirection] = useState("");
  const [platforms, setPlatforms] = useState<Record<string, Platform>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    try {
      const [videoResult, requestResult] = await Promise.all([
        supabase.from("client_media_assets")
          .select("id, title, storage_path, render_path, edit_stage, review_status")
          .eq("client_id", clientId).eq("media_type", "video")
          .order("created_at", { ascending: false }).limit(60),
        supabase.from("video_repurpose_requests")
          .select("id, source_asset_id, direction, status, candidates, error, created_at")
          .eq("client_id", clientId).order("created_at", { ascending: false }).limit(30),
      ]);
      if (videoResult.error) throw videoResult.error;
      if (requestResult.error) throw requestResult.error;
      const eligible = ((videoResult.data ?? []) as Video[]).filter((video) =>
        video.review_status !== "rejected" && video.edit_stage !== "superseded"
        && (video.render_path || ["needs_edit", "editing", "edited"].includes(video.edit_stage)));
      const requestRows = (requestResult.data ?? []) as Request[];
      const requestIds = requestRows.map((request) => request.id);
      const linked = requestIds.length ? await supabase.from("video_repurpose_derivatives")
        .select("request_id, candidate_index, target_platform, idea_id, reentry_stage")
        .in("request_id", requestIds) : { data: [], error: null };
      if (linked.error) throw linked.error;
      setVideos(eligible); setRequests(requestRows);
      setDerivatives((linked.data ?? []) as Derivative[]);
      setUrls(await signPaths("client-media", eligible.map((video) => video.render_path || video.storage_path)));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load video repurposing.");
    } finally { setLoading(false); }
  }, [clientId]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function analyze() {
    if (!sourceId) return;
    setBusy(true); setError(null); setNotice(null);
    const result = await supabase.rpc("request_video_repurpose_insights", {
      p_asset_id: sourceId, p_direction: direction.trim(),
    });
    setBusy(false);
    if (result.error) { setError(result.error.message); return; }
    setNotice("Video analysis queued. Refresh for evidenced quote and clip candidates.");
    void refresh();
  }

  async function branch(request: Request, candidateIndex: number, platform: Platform,
    stage: "ideation" | "brief") {
    setBusy(true); setError(null); setNotice(null);
    const result = await supabase.rpc(stage === "brief"
      ? "brief_video_repurpose_candidate" : "create_video_repurpose_idea", {
      p_request_id: request.id, p_candidate_index: candidateIndex,
      p_target_platform: platform,
    });
    setBusy(false);
    if (result.error) { setError(result.error.message); return; }
    setNotice(stage === "brief" ? "Derivative brief queued. Review it in Briefs before Create."
      : "Draft derivative idea created. Continue in Ideation, then Brief and Create.");
    void refresh();
  }

  return <section className="mt-8 space-y-4 border-t border-border pt-6" aria-label="Repurpose video">
    <h2 className="text-base font-semibold">Repurpose a video</h2>
    <p className="text-xs text-muted-foreground">Analyze the spoken source for exact quote and short clip candidates. Choosing one makes a draft idea with source timestamps; it still needs a brief, creation, and approval.</p>
    <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
      <select aria-label="Video to repurpose" value={sourceId}
        onChange={(event) => setSourceId(event.target.value)}
        className="rounded-md border border-input bg-background px-3 py-2 text-sm">
        <option value="">Choose source video…</option>
        {videos.map((video) => <option key={video.id} value={video.id}>
          {video.title || "Untitled video"} · {video.review_status}
        </option>)}
      </select>
      <button type="button" disabled={busy || !sourceId} onClick={() => void analyze()}
        className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
        {busy ? "Working…" : "Find repurpose ideas"}
      </button>
      <textarea aria-label="Repurpose direction" value={direction} maxLength={2000} rows={2}
        onChange={(event) => setDirection(event.target.value)}
        placeholder="What audience, theme, or part of the video should this focus on?"
        className="rounded-md border border-input bg-background px-3 py-2 text-sm sm:col-span-2" />
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {notice && <p role="status" className="text-xs text-brand-strong">{notice}</p>}
    {loading ? <p className="text-xs text-muted-foreground">Loading repurpose work…</p>
      : requests.length === 0 ? <p className="text-xs text-muted-foreground">No video analysis yet.</p>
        : <div className="space-y-3">{requests.map((request) => {
          const source = videos.find((video) => video.id === request.source_asset_id);
          const path = source?.render_path || source?.storage_path;
          const candidates = Array.isArray(request.candidates) ? request.candidates as Candidate[] : [];
          return <article key={request.id} className="space-y-3 rounded-md border border-border p-3">
            <div className="flex justify-between gap-2"><h3 className="text-sm font-medium">{source?.title || "Source video"}</h3>
              <span className="text-xs capitalize text-muted-foreground">{request.status}</span></div>
            {request.direction && <p className="text-xs text-muted-foreground">Direction: {request.direction}</p>}
            {path && urls.get(path) && <video controls preload="metadata" src={urls.get(path)}
              className="w-full max-w-md rounded-md" />}
            {request.error && <p role="alert" className="text-xs text-destructive">{request.error}</p>}
            {candidates.map((candidate, index) => {
              const key = `${request.id}:${index + 1}`;
              const platform = platforms[key] ?? "instagram";
              const linked = derivatives.find((item) => item.request_id === request.id
                && item.candidate_index === index + 1 && item.target_platform === platform);
              return <div key={key} className="space-y-2 rounded-md bg-muted/40 p-3">
                <p className="text-xs font-semibold">{candidate.kind === "quote_image" ? "Quote image" : "Short clip"} · {candidate.title}</p>
                <p className="text-xs text-muted-foreground">Source {candidate.start_sec.toFixed(1)}–{candidate.end_sec.toFixed(1)}s · {candidate.reason}</p>
                <blockquote className="border-l-2 border-primary pl-2 text-xs">{candidate.exact_quote}</blockquote>
                <div className="flex flex-wrap items-center gap-2">
                  <select aria-label={`Destination for ${candidate.title}`} value={platform}
                    onChange={(event) => setPlatforms({ ...platforms, [key]: event.target.value as Platform })}
                    className="rounded-md border border-input bg-background px-2 py-1 text-xs">
                    {PLATFORMS.filter((item) => candidate.kind !== "short_clip" || item !== "linkedin")
                      .map((item) => <option key={item} value={item} className="capitalize">{item}</option>)}
                  </select>
                  {linked && <Link to={`/clients/${clientId}/delivery/ideation?tab=${linked.reentry_stage === "brief" ? "briefs" : "generation"}`}
                    className="text-xs font-medium text-brand-strong hover:underline">
                    Open {linked.reentry_stage === "brief" ? "brief" : "draft idea"}</Link>}
                  {!linked && <button type="button" disabled={busy} onClick={() => void branch(request, index + 1, platform, "ideation")}
                      className="text-xs font-medium text-brand-strong hover:underline disabled:opacity-50">
                      Send to Ideation
                    </button>}
                  {linked?.reentry_stage !== "brief" && <button type="button" disabled={busy}
                    onClick={() => void branch(request, index + 1, platform, "brief")}
                    className="text-xs font-medium text-brand-strong hover:underline disabled:opacity-50">
                    Create brief
                  </button>}
                </div>
              </div>;
            })}
          </article>;
        })}</div>}
    <button type="button" onClick={() => void refresh()} className="text-xs font-medium text-brand-strong hover:underline">Refresh repurpose work</button>
  </section>;
}
