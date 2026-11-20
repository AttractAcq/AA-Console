import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { VideoApprovalRoute } from "../../components/VideoApprovalRoute";
import { supabase } from "../../lib/supabase";
import { useSignedPreviewPaths } from "../../lib/useSignedPreviewPaths";

type Attachment = { id: string; project_id: string; ir_version: number;
  first_candidate_id: string; asset_id: string; attached_at: string };
type Asset = { id: string; title: string | null; review_status: string;
  human_approved_at: string | null; storage_path: string;
  render_path: string | null };

export function CodeVideoAttachmentsPanel({ clientId, titles }: {
  clientId: string | undefined;
  titles: ReadonlyMap<string, string>;
}) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [assets, setAssets] = useState<ReadonlyMap<string, Asset>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestEpoch = useRef(0);
  const urls = useSignedPreviewPaths("client-media", [...assets.values()]
    .map((asset) => asset.render_path ?? asset.storage_path));

  const refresh = useCallback(async () => {
    const epoch = ++requestEpoch.current;
    if (!clientId) { setAttachments([]); setAssets(new Map());
      setLoading(false); return; }
    setLoading(true);
    const attached = await supabase.from("video_project_attachments_v1")
      .select("id,project_id,ir_version,first_candidate_id,asset_id,attached_at")
      .eq("client_id", clientId)
      .order("attached_at", { ascending: false }).limit(30);
    if (epoch !== requestEpoch.current) return;
    if (attached.error) {
      setError(attached.error.message); setLoading(false); return;
    }
    const rows = (attached.data ?? []) as Attachment[];
    if (rows.length === 0) {
      setAttachments([]); setAssets(new Map()); setError(null);
      setLoading(false); return;
    }
    const assetResult = await supabase.from("client_media_assets")
      .select("id,title,review_status,human_approved_at,storage_path,render_path")
      .eq("client_id", clientId).in("id", rows.map((row) => row.asset_id));
    if (epoch !== requestEpoch.current) return;
    if (assetResult.error) {
      setError(assetResult.error.message); setLoading(false); return;
    }
    setAttachments(rows);
    setAssets(new Map(((assetResult.data ?? []) as Asset[]).map((asset) =>
      [asset.id, asset])));
    setError(null); setLoading(false);
  }, [clientId]);
  useEffect(() => {
    void refresh();
    return () => { requestEpoch.current += 1; };
  }, [refresh]);

  async function finish(assetId: string) {
    setError(null); setNotice(null);
    const result = await supabase.rpc("review_media_asset", {
      p_asset_id: assetId, p_decision: "approved" });
    if (result.error) { setError(result.error.message); return; }
    setNotice("Human video approval recorded for this asset version.");
    void refresh();
  }

  return <section aria-label="Code-video attached assets" className="space-y-2">
    <h3 className="text-xs font-semibold">Finished videos for human review</h3>
    <p className="text-xs text-muted-foreground">Attachment makes a review-ready asset. Owner, SMM and any requested client sign-offs are separate from rendering.</p>
    {loading && <p className="text-xs text-muted-foreground">Loading attached videos…</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {notice && <p role="status" className="text-xs">{notice}</p>}
    {!loading && !error && attachments.length === 0 &&
      <p className="text-xs text-muted-foreground">No attached videos yet.</p>}
    {attachments.map((attachment) => {
      const asset = assets.get(attachment.asset_id);
      const url = asset && urls.get(asset.render_path ?? asset.storage_path);
      return <article key={attachment.id} className="space-y-2 rounded-md border border-border p-3 text-xs">
        <h4 className="font-medium">{titles.get(attachment.project_id)
          ?? asset?.title ?? "Video project"} · IR v{attachment.ir_version}</h4>
        {!asset ? <p role="alert" className="text-destructive">Attached asset is unavailable.</p>
          : <>
            <p>Status: {asset.human_approved_at ? "human approved"
              : asset.review_status === "rejected" ? "changes requested"
                : "awaiting human approval"}</p>
            {url ? <video controls preload="metadata" className="w-full max-w-md rounded-md"
              aria-label={`Review ${asset.title ?? "video"}`} src={url} />
              : <p className="text-muted-foreground">Private preview unavailable.</p>}
            {!asset.human_approved_at && asset.review_status !== "rejected" && url
              && clientId && <VideoApprovalRoute clientId={clientId} assetId={asset.id}
                onFinalApprove={() => finish(asset.id)} />}
            <Link className="text-brand-strong underline"
              to={`/clients/${clientId}/delivery/approval-inbox?tab=assets`}>Open Approval Inbox</Link>
          </>}
        <details><summary className="cursor-pointer">Attachment receipt</summary>
          <p>Asset: {attachment.asset_id}</p>
          <p>First candidate: {attachment.first_candidate_id}</p>
          <p>Attached: {attachment.attached_at}</p>
        </details>
      </article>;
    })}
  </section>;
}
