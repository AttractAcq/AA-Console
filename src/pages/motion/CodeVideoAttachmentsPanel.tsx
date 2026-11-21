import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { VideoApprovalRoute } from "../../components/VideoApprovalRoute";
import { supabase } from "../../lib/supabase";
import { useSignedPreviewPaths } from "../../lib/useSignedPreviewPaths";

type Attachment = { id: string; project_id: string; ir_version: number;
  first_candidate_id: string; thumbnail_attempt_id: string | null;
  asset_id: string; attached_at: string };
type Asset = { id: string; title: string | null; review_status: string;
  human_approved_at: string | null; storage_path: string;
  render_path: string | null };
type Thumbnail = { id: string; project_id: string; ir_version: number;
  first_candidate_id: string; state: string; storage_path: string | null;
  file_sha256: string | null; file_bytes: number | null };
type Candidate = { id: string; project_id: string; ir_version: number;
  aspect: string; verdict: string; probe_result: string;
  storage_path: string; file_sha256: string };

export function CodeVideoAttachmentsPanel({ clientId, titles }: {
  clientId: string | undefined;
  titles: ReadonlyMap<string, string>;
}) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [assets, setAssets] = useState<ReadonlyMap<string, Asset>>(new Map());
  const [thumbnails, setThumbnails] = useState<ReadonlyMap<string, Thumbnail>>(new Map());
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const requestEpoch = useRef(0);
  const urls = useSignedPreviewPaths("client-media", [
    ...[...assets.values()].map((asset) => asset.render_path ?? asset.storage_path),
    ...[...thumbnails.values()].map((thumbnail) => thumbnail.storage_path),
    ...candidates.map((candidate) => candidate.storage_path),
  ]);

  const refresh = useCallback(async () => {
    const epoch = ++requestEpoch.current;
    if (!clientId) { setAttachments([]); setAssets(new Map()); setThumbnails(new Map());
      setCandidates([]);
      setLoading(false); return; }
    setLoading(true);
    const attached = await supabase.from("video_project_attachments_v1")
      .select("id,project_id,ir_version,first_candidate_id,thumbnail_attempt_id,asset_id,attached_at")
      .eq("client_id", clientId)
      .order("attached_at", { ascending: false }).limit(30);
    if (epoch !== requestEpoch.current) return;
    if (attached.error) {
      setError(attached.error.message); setLoading(false); return;
    }
    const rows = (attached.data ?? []) as Attachment[];
    if (rows.length === 0) {
      setAttachments([]); setAssets(new Map()); setThumbnails(new Map());
      setCandidates([]); setError(null);
      setLoading(false); return;
    }
    const thumbnailIds = rows.flatMap((row) => row.thumbnail_attempt_id
      ? [row.thumbnail_attempt_id] : []);
    const [assetResult, thumbnailResult, candidateResult] = await Promise.all([
      supabase.from("client_media_assets")
        .select("id,title,review_status,human_approved_at,storage_path,render_path")
        .eq("client_id", clientId).in("id", rows.map((row) => row.asset_id)),
      thumbnailIds.length ? supabase.from("video_project_thumbnail_attempts_v1")
        .select("id,project_id,ir_version,first_candidate_id,state,storage_path,file_sha256,file_bytes")
        .eq("client_id", clientId).in("id", thumbnailIds)
        : Promise.resolve({ data: [], error: null }),
      supabase.from("video_project_render_candidates_v1")
        .select("id,project_id,ir_version,aspect,verdict,probe_result,storage_path,file_sha256")
        .eq("client_id", clientId)
        .eq("verdict", "accepted")
        .eq("probe_result", "pass")
        .or(rows.map((row) => `and(project_id.eq.${row.project_id},ir_version.eq.${row.ir_version})`)
          .join(","))
        .limit(90),
    ]);
    if (epoch !== requestEpoch.current) return;
    if (assetResult.error || thumbnailResult.error || candidateResult.error) {
      setError(assetResult.error?.message ?? thumbnailResult.error?.message
        ?? candidateResult.error?.message
        ?? "Could not load exact video attachment evidence.");
      setLoading(false); return;
    }
    setAttachments(rows);
    setAssets(new Map(((assetResult.data ?? []) as Asset[]).map((asset) =>
      [asset.id, asset])));
    setThumbnails(new Map(((thumbnailResult.data ?? []) as Thumbnail[])
      .map((thumbnail) => [thumbnail.id, thumbnail])));
    setCandidates((candidateResult.data ?? []) as Candidate[]);
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

  async function downloadVideo(candidate: Candidate, title: string,
    includeAspect = false) {
    setError(null); setNotice(null);
    const filename = `${title
      .replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 80)
      || "reviewed-video"}${includeAspect
      ? `-${candidate.aspect.replace(":", "x")}` : ""}.mp4`;
    setDownloading(candidate.id);
    try {
      const signed = await supabase.storage.from("client-media")
        .createSignedUrl(candidate.storage_path,300);
      if (signed.error || !signed.data?.signedUrl) {
        throw new Error("Could not prepare the private MP4 download.");
      }
      const response = await fetch(signed.data.signedUrl);
      if (!response.ok) throw new Error("Could not retrieve the private MP4.");
      const bytes = await response.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (hash !== candidate.file_sha256.toLowerCase()) {
        throw new Error("The downloaded MP4 does not match its filed SHA-256 receipt.");
      }
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = filename;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
      setNotice(`Verified ${filename} against the filed SHA-256 receipt.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message
        : "Could not verify the private MP4 download.");
    } finally { setDownloading(null); }
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
      const thumbnail = attachment.thumbnail_attempt_id
        ? thumbnails.get(attachment.thumbnail_attempt_id) : undefined;
      const thumbnailPath = thumbnail?.state === "filed"
        && thumbnail.project_id === attachment.project_id
        && thumbnail.ir_version === attachment.ir_version
        && thumbnail.first_candidate_id === attachment.first_candidate_id
        ? thumbnail.storage_path : null;
      const thumbnailUrl = thumbnailPath ? urls.get(thumbnailPath) : null;
      const aspectFiles = candidates.filter((candidate) =>
        candidate.project_id === attachment.project_id
        && candidate.ir_version === attachment.ir_version
        && candidate.verdict === "accepted"
        && candidate.probe_result === "pass");
      const firstCandidate = asset && aspectFiles.find((candidate) =>
        candidate.id === attachment.first_candidate_id
        && candidate.storage_path === (asset.render_path ?? asset.storage_path));
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
            {thumbnailUrl ? <img src={thumbnailUrl} alt={`Thumbnail for ${asset.title ?? "video"}`}
              className="w-full max-w-md rounded-md" />
              : <p className="text-muted-foreground">{attachment.thumbnail_attempt_id
                ? "Private thumbnail preview unavailable."
                : "Historical attachment has no filed thumbnail receipt."}</p>}
            {url && firstCandidate && <button type="button"
              disabled={downloading !== null}
              onClick={() => void downloadVideo(firstCandidate,
                asset.title ?? "reviewed-video")}
              className="text-brand-strong underline disabled:opacity-50">
              {downloading === firstCandidate.id ? "Verifying MP4…" : "Download verified MP4"}</button>}
            {!firstCandidate && <p role="alert" className="text-destructive">
              First-aspect candidate receipt is unavailable or does not match the asset path;
              download and approval are held.</p>}
            {aspectFiles.length > 0 && <div className="space-y-1" aria-label="Requested video aspect files">
              <p className="font-medium">Requested aspect files</p>
              <p className="text-muted-foreground">Each file passed its media probe and creative review. The human asset decision above applies to the first aspect; inspect derivatives before external use.</p>
              {aspectFiles.map((candidate) => <div key={candidate.id} className="flex flex-wrap items-center gap-2">
                <span>{candidate.aspect} · {candidate.id === attachment.first_candidate_id
                  ? "first aspect" : "derivative"}</span>
                {urls.get(candidate.storage_path)
                  ? <button type="button" disabled={downloading !== null}
                    onClick={() => void downloadVideo(candidate, asset.title ?? "video", true)}
                    className="text-brand-strong underline disabled:opacity-50">
                    {downloading === candidate.id ? "Verifying MP4…"
                      : `Download verified ${candidate.aspect} MP4`}</button>
                  : <span className="text-muted-foreground">Private file unavailable</span>}
                <details><summary className="cursor-pointer">Receipt</summary>
                  <p>Candidate: {candidate.id}</p>
                  <p className="break-all">SHA-256: {candidate.file_sha256}</p>
                </details>
              </div>)}
            </div>}
            {!asset.human_approved_at && asset.review_status !== "rejected" && url
              && firstCandidate
              && clientId && <VideoApprovalRoute clientId={clientId} assetId={asset.id}
                onFinalApprove={() => finish(asset.id)} />}
            <Link className="text-brand-strong underline"
              to={`/clients/${clientId}/delivery/approval-inbox?tab=assets`}>Open Approval Inbox</Link>
          </>}
        <details><summary className="cursor-pointer">Attachment receipt</summary>
          <p>Asset: {attachment.asset_id}</p>
          <p>First candidate: {attachment.first_candidate_id}</p>
          <p>Thumbnail receipt: {attachment.thumbnail_attempt_id ?? "unknown (historical)"}</p>
          {thumbnail?.file_sha256 && <p className="break-all">Thumbnail SHA-256: {thumbnail.file_sha256}</p>}
          <p>Attached: {attachment.attached_at}</p>
        </details>
      </article>;
    })}
  </section>;
}
