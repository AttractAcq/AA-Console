import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";
import { GenerationPanel } from "../ideation/GenerationPanel";
import { ApproveAndBuildModal } from "../../components/briefs/ApproveAndBuildModal";
import { BriefDetailModal } from "../../components/briefs/BriefDetailModal";
import { MediaDetailModal } from "../../components/MediaDetailModal";
import { signPaths, type MediaAsset } from "../../lib/media";

type Brief = Database["public"]["Tables"]["client_briefs"]["Row"];
const buttonClass = "rounded-md border border-border px-2.5 py-1 text-xs font-medium text-card-foreground hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function CampaignContentPanel({ clientId, campaignId, contentCount, onChanged, refreshToken }: {
  clientId: string;
  campaignId: string;
  contentCount: number;
  onChanged: () => void;
  refreshToken?: unknown;
}) {
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [linkedIds, setLinkedIds] = useState<string[]>([]);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [selected, setSelected] = useState("");
  const [building, setBuilding] = useState<Brief | null>(null);
  const [viewing, setViewing] = useState<Brief | null>(null);
  const [preview, setPreview] = useState<MediaAsset | null>(null);
  const [rejecting, setRejecting] = useState<MediaAsset | null>(null);
  const [reason, setReason] = useState("");
  const [showIdeas, setShowIdeas] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [briefRows, links] = await Promise.all([
        supabase.from("client_briefs").select("*").eq("client_id", clientId).order("created_at", { ascending: false }),
        supabase.from("campaign_artifacts").select("brief_id, asset_id").eq("client_id", clientId).eq("campaign_id", campaignId).eq("kind", "content"),
      ]);
      if (briefRows.error) throw briefRows.error;
      if (links.error) throw links.error;
      const ids = (links.data ?? []).flatMap((link) => link.brief_id ? [link.brief_id] : []);
      const directAssetIds = (links.data ?? []).flatMap((link) => link.asset_id ? [link.asset_id] : []);
      // Read both kinds of existing campaign links, including human deliveries
      // which inherit their brief_id from the normal production workspace.
      const [byBrief, direct] = await Promise.all([
        ids.length ? supabase.from("client_media_assets").select("*").eq("client_id", clientId).in("brief_id", ids) : { data: [], error: null },
        directAssetIds.length ? supabase.from("client_media_assets").select("*").eq("client_id", clientId).in("id", directAssetIds) : { data: [], error: null },
      ]);
      if (byBrief.error) throw byBrief.error;
      if (direct.error) throw direct.error;
      const rows = [...new Map([...(byBrief.data ?? []), ...(direct.data ?? [])].map((asset) => [asset.id, asset])).values()] as MediaAsset[];
      setBriefs(briefRows.data ?? []);
      setLinkedIds(ids);
      setAssets(rows);
      setUrls(await signPaths("client-media", rows.map((asset) => asset.storage_path)));
    } catch (error) {
      setError(error instanceof Error ? error.message : (error as { message?: string }).message ?? "Could not load campaign content.");
    } finally {
      setLoading(false);
    }
  }, [clientId, campaignId]);

  useEffect(() => { void refresh(); }, [refresh, refreshToken]);
  // Human uploads and reviews do not necessarily finish an agent job.
  useEffect(() => {
    const channel = supabase.channel(`campaign-content:${campaignId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "client_media_assets", filter: `client_id=eq.${clientId}` }, () => { void refresh(); onChanged(); })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [campaignId, clientId, refresh, onChanged]);

  async function act(work: () => PromiseLike<{ error: { message: string } | null }>, message: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await work();
      if (result.error) throw result.error;
      setNotice(message);
      await refresh();
      onChanged();
    } catch (error) {
      setError(error instanceof Error ? error.message : (error as { message?: string }).message ?? "Something went wrong.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const linked = briefs.filter((brief) => linkedIds.includes(brief.id));
  const available = briefs.filter((brief) => !linkedIds.includes(brief.id));
  const ready = assets.filter((asset) => asset.review_status === "approved").length;

  return <section className="mt-4 space-y-3 border-t border-border pt-4" aria-label="Campaign content production">
    <h4 className="text-sm font-semibold">Content production</h4>
    <p className="text-xs text-muted-foreground">{ready} ready to distribute · {contentCount} pieces planned · {linked.length} briefs attached</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-brand-strong">{notice}</p>}
    <button type="button" className={buttonClass} aria-expanded={showIdeas} onClick={() => setShowIdeas(!showIdeas)}>Ideation</button>
    {showIdeas && <div className="rounded-md border border-border p-3">
      <p className="mb-3 text-xs text-muted-foreground">These ideas are shared with this client's Ideation page. Create or approve an idea here, then attach its brief below when it arrives.</p>
      <GenerationPanel key={clientId} watchJobs={false} refreshToken={refreshToken} />
    </div>}
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label="Brief to attach" className="rounded-md border border-input bg-background px-2 py-1 text-sm" value={selected} onChange={(event) => setSelected(event.target.value)} disabled={busy || loading}>
        <option value="">Choose a client brief…</option>
        {available.map((brief) => <option key={brief.id} value={brief.id}>{brief.title} · {brief.media_type}</option>)}
      </select>
      <button type="button" className={buttonClass} disabled={busy || !available.some((brief) => brief.id === selected)} onClick={() => void act(() => supabase.from("campaign_artifacts").insert({ client_id: clientId, campaign_id: campaignId, kind: "content", brief_id: selected }), "Brief attached to this campaign.")}>Attach brief</button>
      <button type="button" className={buttonClass} disabled={busy} onClick={() => void refresh()}>Refresh content</button>
    </div>
    {loading ? <p className="text-xs text-muted-foreground">Loading content…</p> : <>
      {linked.length === 0 && <p className="text-xs text-muted-foreground">Attach a brief to start production for this campaign.</p>}
      {linked.map((brief) => <div key={brief.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3">
        <button type="button" className="text-sm text-brand-strong hover:underline" onClick={() => setViewing(brief)}>{brief.title}</button>
        <span className="text-xs text-muted-foreground">{brief.status.replace(/_/g, " ")}</span>
        {(brief.status === "draft" || brief.status === "approved") && <button type="button" className={buttonClass} disabled={busy} onClick={() => setBuilding(brief)}>Approve &amp; Build</button>}
      </div>)}
      {assets.map((asset) => <div key={asset.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3">
        <button type="button" className="text-sm text-brand-strong hover:underline" onClick={() => setPreview(asset)}>Preview {asset.title ?? "asset"}</button>
        <span className="text-xs text-muted-foreground">{asset.review_status === "approved" ? "Ready to distribute" : asset.review_status === "pending" ? "Awaiting approval" : "Rejected"}</span>
        {asset.review_status === "pending" && <>
          <button type="button" className={buttonClass} disabled={busy} onClick={() => void act(() => supabase.rpc("review_media_asset", { p_asset_id: asset.id, p_decision: "approved" }), "Asset approved. Ready to distribute.")}>Approve asset</button>
          <button type="button" className={buttonClass} disabled={busy} onClick={() => { setRejecting(asset); setReason(""); }}>Reject asset</button>
        </>}
      </div>)}
    </>}
    {rejecting && <div className="rounded-md border border-border p-3">
      <label className="text-sm">Reason for rejecting {rejecting.title ?? "asset"}
        <textarea className="mt-2 block w-full rounded-md border border-input bg-background p-2" value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <button type="button" className={buttonClass} disabled={busy || !reason.trim()} onClick={() => {
        const asset = rejecting;
        void act(() => supabase.rpc("review_media_asset", { p_asset_id: asset.id, p_decision: "rejected", p_reason: reason.trim() }), "Asset rejected with feedback.");
        setRejecting(null);
      }}>Confirm rejection</button>
      <button type="button" className={buttonClass} onClick={() => setRejecting(null)}>Cancel</button>
    </div>}
    <BriefDetailModal brief={viewing} open={viewing !== null} onClose={() => setViewing(null)} />
    <ApproveAndBuildModal brief={building} open={building !== null} onClose={() => setBuilding(null)} onDone={() => { void refresh(); onChanged(); setNotice("Production queued. Assets will appear here for approval."); }} />
    <MediaDetailModal asset={preview} url={preview ? urls.get(preview.storage_path) : undefined} open={preview !== null} onClose={() => setPreview(null)} />
  </section>;
}
