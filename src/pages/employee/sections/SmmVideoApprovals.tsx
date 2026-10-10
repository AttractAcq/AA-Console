import { useCallback, useEffect, useState } from "react";
import { VideoApprovalRoute } from "../../../components/VideoApprovalRoute";
import { signPaths } from "../../../lib/media";
import { supabase } from "../../../lib/supabase";

type Video = { id: string; client_id: string; title: string | null; content_format: string | null;
  storage_path: string; render_path: string | null; created_at: string };
type Slot = { id: string; asset_id: string | null };

/** The assigned SMM's human gate, including engine reels that need approve_slot. */
export function SmmVideoApprovals({ memberId }: { memberId: string }) {
  const [videos, setVideos] = useState<Video[]>([]);
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map());
  const [slots, setSlots] = useState<ReadonlyMap<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const { data: assigned, error: assignmentError } = await supabase.from("client_assignments")
        .select("client_id, clients(name)").eq("member_id", memberId).is("ended_at", null);
      if (assignmentError) throw assignmentError;
      const clients = (assigned ?? []) as unknown as Array<{ client_id: string; clients: { name: string } | null }>;
      const ids = [...new Set(clients.map((row) => row.client_id))];
      setNames(new Map(clients.map((row) => [row.client_id, row.clients?.name ?? "Client"])));
      if (ids.length === 0) {
        setVideos([]); setUrls(new Map()); setSlots(new Map()); return;
      }
      const { data: assets, error: assetError } = await supabase.from("client_media_assets")
        .select("id, client_id, title, content_format, storage_path, render_path, created_at")
        .in("client_id", ids).eq("media_type", "video").eq("edit_stage", "review_ready")
        .is("human_approved_at", null).order("created_at", { ascending: false });
      if (assetError) throw assetError;
      const rows = ((assets ?? []) as Video[]).filter((row) =>
        row.content_format !== "reel" || Boolean(row.render_path));
      const { data: engineSlots, error: slotError } = await supabase.from("content_slots")
        .select("id, asset_id").in("client_id", ids).eq("stage", "awaiting_approval");
      if (slotError) throw slotError;
      setVideos(rows);
      setSlots(new Map(((engineSlots ?? []) as Slot[]).flatMap((slot) =>
        slot.asset_id ? [[slot.asset_id, slot.id] as const] : [])));
      setUrls(await signPaths("client-media", rows.map((row) => row.render_path ?? row.storage_path)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load video approvals.");
    } finally { setLoading(false); }
  }, [memberId]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function finalize(video: Video) {
    setBusy(video.id);
    setError(null);
    const slotId = slots.get(video.id);
    const result = slotId
      ? await supabase.rpc("approve_slot", { p_slot_id: slotId })
      : await supabase.rpc("review_media_asset", { p_asset_id: video.id, p_decision: "approved" });
    setBusy(null);
    if (result.error) { setError(result.error.message); return; }
    void refresh();
  }

  return <section className="space-y-4">
    <p className="text-sm text-muted-foreground">Review the finished cut, sign as the assigned SMM, and request client approval when needed. The owner must also sign before final approval.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {loading ? <p className="text-sm text-muted-foreground">Loading video approvals…</p>
      : videos.length === 0 ? <p className="text-sm text-muted-foreground">No finished videos are waiting for your review.</p>
        : videos.map((video) => {
          const path = video.render_path ?? video.storage_path;
          return <article key={video.id} className="space-y-3 rounded-lg border border-border p-4">
            <div><h2 className="font-medium">{video.title ?? "Video"}</h2>
              <p className="text-xs text-muted-foreground">{names.get(video.client_id) ?? "Client"} · {video.content_format ?? "Video"}
                {slots.has(video.id) ? " · Scheduled after approval" : ""}</p></div>
            {urls.get(path) ? <video controls preload="metadata" className="w-full max-w-xl rounded-md"
              src={urls.get(path)} aria-label={`Review ${video.title ?? "video"}`} />
              : <p role="alert" className="text-xs text-destructive">Video preview unavailable. Retry before signing.</p>}
            {urls.get(path) && <VideoApprovalRoute assetId={video.id}
              onFinalApprove={() => finalize(video)} />}
            {busy === video.id && <p className="text-xs text-muted-foreground">Finalizing…</p>}
          </article>;
        })}
    <button type="button" onClick={() => void refresh()} className="text-xs font-medium text-brand-strong">Refresh approvals</button>
  </section>;
}
