import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Trash2 } from "lucide-react";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";
import { ApproveAndBuildModal } from "../../components/briefs/ApproveAndBuildModal";
import { BriefDetailModal } from "../../components/briefs/BriefDetailModal";
import { MediaDetailModal } from "../../components/MediaDetailModal";
import { AdCopyModal, type AdCopyAsset } from "../../components/AdCopyModal";
import { allowedCtas } from "../../lib/campaignTemplates";
import { signPaths, type MediaAsset } from "../../lib/media";
import { formatLabel } from "../../lib/contentFormat";
import { cn } from "../../lib/cn";
import { RegenerateAction } from "../../components/RegenerateAction";

type Idea = Database["public"]["Tables"]["client_ideas"]["Row"];
type Brief = Database["public"]["Tables"]["client_briefs"]["Row"];
const buttonClass = "rounded-md border border-border px-2.5 py-1 text-xs font-medium text-card-foreground hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

type BusyAction = "approve" | "brief" | "plan" | "delete";

/** An asset as this panel loads it: select("*") carries the ad columns too. */
type CampaignAsset = MediaAsset & AdCopyAsset;

/** Any copy at all puts an asset in the build — the same rule the build uses (isAdCandidate). */
function hasAdCopy(asset: CampaignAsset): boolean {
  return [asset.ad_primary_text, asset.ad_headline, asset.ad_link_url, asset.ad_cta].some((v) => (v ?? "").trim() !== "");
}

export function CampaignContentPanel({ clientId, campaignId, contentCount, builtAt, contentIdeasGeneratedAt, template = null, mirrorsTemplate = null, onChanged, refreshToken, layout = "v1" }: {
  clientId: string;
  campaignId: string;
  /** The campaign template, which decides which Meta buttons an ad may carry. */
  template?: string | null;
  mirrorsTemplate?: string | null;
  contentCount: number;
  builtAt: string | null;
  contentIdeasGeneratedAt: string | null;
  onChanged: () => void;
  refreshToken?: unknown;
  layout?: "v1" | "v2";
}) {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [assets, setAssets] = useState<CampaignAsset[]>([]);
  const [copying, setCopying] = useState<CampaignAsset | null>(null);
  const [landingUrl, setLandingUrl] = useState<string | null>(null);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [artifactPackages, setArtifactPackages] = useState<{ briefs: Map<string, string>; assets: Map<string, string>; versions: Map<string, number> }>({ briefs: new Map(), assets: new Map(), versions: new Map() });
  const [building, setBuilding] = useState<Brief | null>(null);
  const [viewing, setViewing] = useState<Brief | null>(null);
  const [preview, setPreview] = useState<MediaAsset | null>(null);
  const [rejecting, setRejecting] = useState<MediaAsset | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<{ id: string; action: BusyAction } | null>(null);
  const inFlight = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Collapsed on load, every time. A campaign with twelve ideas opened a page
  // of twelve full bodies; nobody scrolls that to find one. Match the empty-Set
  // pattern CampaignExecutionPanel uses for campaign cards.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openAssetActions, setOpenAssetActions] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [ideaRows, links, pageLinks, versionRows] = await Promise.all([
        supabase.from("client_ideas").select("*").eq("client_id", clientId).eq("campaign_id", campaignId).order("campaign_position", { ascending: true }),
        supabase.from("campaign_artifacts").select("brief_id, asset_id, manifest_id").eq("client_id", clientId).eq("campaign_id", campaignId).eq("kind", "content"),
        // Where an ad's link is drafted from: the campaign's own published page.
        supabase.from("campaign_artifacts").select("client_pages(published_url)").eq("client_id", clientId).eq("campaign_id", campaignId).eq("kind", "landing_page"),
        layout === "v2" ? supabase.from("campaign_manifest_versions")
          .select("id, version").eq("client_id", clientId).eq("campaign_id", campaignId)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (ideaRows.error) throw ideaRows.error;
      if (links.error) throw links.error;
      if (versionRows.error) throw versionRows.error;
      setArtifactPackages({
        briefs: new Map((links.data ?? []).filter((link) => link.brief_id && link.manifest_id).map((link) => [link.brief_id!, link.manifest_id!])),
        assets: new Map((links.data ?? []).filter((link) => link.asset_id && link.manifest_id).map((link) => [link.asset_id!, link.manifest_id!])),
        versions: new Map((versionRows.data ?? []).map((row) => [row.id, row.version])),
      });
      const ids = (links.data ?? []).flatMap((link) => link.brief_id ? [link.brief_id] : []);
      const directAssetIds = (links.data ?? []).flatMap((link) => link.asset_id ? [link.asset_id] : []);
      const [briefRows, byBrief, direct] = await Promise.all([
        ids.length ? supabase.from("client_briefs").select("*").eq("client_id", clientId).in("id", ids) : { data: [], error: null },
        ids.length ? supabase.from("client_media_assets").select("*").eq("client_id", clientId).in("brief_id", ids) : { data: [], error: null },
        directAssetIds.length ? supabase.from("client_media_assets").select("*").eq("client_id", clientId).in("id", directAssetIds) : { data: [], error: null },
      ]);
      if (briefRows.error) throw briefRows.error;
      if (byBrief.error) throw byBrief.error;
      if (direct.error) throw direct.error;
      const rows = [...new Map([...(byBrief.data ?? []), ...(direct.data ?? [])].map((asset) => [asset.id, asset])).values()] as CampaignAsset[];
      const pages = (pageLinks.data ?? []) as { client_pages: { published_url: string | null } | null }[];
      setLandingUrl(pages.map((p) => p.client_pages?.published_url).find((u) => u) ?? null);
      setIdeas((ideaRows.data ?? []) as Idea[]);
      setBriefs(briefRows.data ?? []);
      setAssets(rows);
      setUrls(await signPaths("client-media", rows.map((asset) => asset.storage_path)));
    } catch (error) {
      setError(error instanceof Error ? error.message : (error as { message?: string }).message ?? "Could not load campaign content.");
    } finally {
      setLoading(false);
    }
  }, [clientId, campaignId, layout]);

  useEffect(() => { void refresh(); }, [refresh, refreshToken]);
  // Human uploads and reviews do not necessarily finish an agent job.
  useEffect(() => {
    const channel = supabase.channel(`campaign-content:${campaignId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "client_media_assets", filter: `client_id=eq.${clientId}` }, () => { void refresh(); onChanged(); })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [campaignId, clientId, refresh, onChanged]);

  async function act(work: () => PromiseLike<{ error: { message: string } | null }>, message: string, action: { id: string; action: BusyAction }) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(action);
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
      setBusy(null);
    }
  }

  /**
   * Remove one campaign content piece: the idea and the briefs/assets made
   * from it. Never the parent campaign, and never a sibling idea.
   */
  async function deleteIdea(idea: Idea) {
    const warning =
      `Delete "${idea.title}"? This also deletes briefs and assets produced ` +
      `from this idea. The campaign itself stays. It cannot be undone.`;
    if (!window.confirm(warning)) return;
    await act(
      () => supabase.rpc("delete_client_idea", { p_idea_id: idea.id }),
      "Idea deleted.",
      { id: idea.id, action: "delete" },
    );
  }

  const briefById = new Map(briefs.map((brief) => [brief.id, brief]));
  const ideaById = new Map(ideas.map((idea) => [idea.id, idea]));

  // One piece of content is an idea, the brief written from it, and the assets
  // produced from that brief. Listed separately, a campaign with twelve ideas
  // buried its one brief below all of them, and a briefed idea showed no sign
  // that its brief existed at all. Grouped, the chain is the unit of work.
  const briefsByIdea = new Map<string, Brief[]>();
  for (const brief of briefs) {
    if (!brief.source_idea_id) continue;
    const list = briefsByIdea.get(brief.source_idea_id) ?? [];
    list.push(brief);
    briefsByIdea.set(brief.source_idea_id, list);
  }
  const assetsByBrief = new Map<string, MediaAsset[]>();
  for (const asset of assets) {
    if (!asset.brief_id) continue;
    const list = assetsByBrief.get(asset.brief_id) ?? [];
    list.push(asset);
    assetsByBrief.set(asset.brief_id, list);
  }
  // Anything whose brief or idea has gone is still work somebody did, so it is
  // shown rather than silently dropped.
  const looseAssets = assets.filter(
    (asset) => !asset.brief_id || !briefById.has(asset.brief_id),
  );
  const looseBriefs = briefs.filter(
    (brief) => !brief.source_idea_id || !ideaById.has(brief.source_idea_id),
  );
  const ready = new Set(
    assets.filter((asset) => asset.review_status === "approved" && asset.storage_path).map((asset) => {
      const brief = asset.brief_id ? briefById.get(asset.brief_id) : null;
      const idea = brief?.source_idea_id ? ideaById.get(brief.source_idea_id) : null;
      return idea ? `idea:${idea.id}` : brief ? `brief:${brief.id}` : `asset:${asset.id}`;
    }),
  ).size;
  const busyFor = (id: string, action: BusyAction) => busy?.id === id && busy.action === action;

  /**
   * An asset and what can be done about it, wherever it is shown.
   *
   * A function rather than a component: a component declared inside render is a
   * new type on every render, so React unmounts and remounts its subtree each
   * time — which throws away focus and any in-flight interaction.
   */
  const assetRow = (asset: CampaignAsset) => (
    <div key={asset.id} className="flex flex-wrap items-center gap-2">
      <button type="button" className="text-sm text-brand-strong hover:underline" onClick={() => setPreview(asset)}>
        Preview {asset.title ?? "asset"}
      </button>
      <span className="text-xs text-muted-foreground">
        {asset.review_status === "approved" ? "Ready to distribute" : asset.review_status === "pending" ? "Awaiting approval" : "Rejected"}
      </span>
      {/* Only an approved single image can be built as a Meta ad. Copy on
          it is what puts it into the campaign's next build. */}
      {asset.review_status === "approved" && asset.media_type === "image" && asset.content_format !== "carousel" && <>
        <span className="text-xs text-muted-foreground">
          {asset.meta_ad_id ? "· Built in Meta" : hasAdCopy(asset) ? "· Has ad copy" : "· No ad copy"}
        </span>
        <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => setCopying(asset)}>
          {hasAdCopy(asset) ? "Edit ad copy" : "Write ad copy"}
        </button>
      </>}
      {asset.review_status === "pending" && <>
        <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void act(() => supabase.rpc("review_media_asset", { p_asset_id: asset.id, p_decision: "approved" }), "Asset approved. Ready to distribute.", { id: asset.id, action: "approve" })}>Approve asset</button>
        <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => { setRejecting(asset); setReason(""); }}>Reject asset</button>
      </>}
    </div>
  );

  const modals = <>
    <BriefDetailModal brief={viewing} open={viewing !== null} onClose={() => setViewing(null)} />
    <ApproveAndBuildModal brief={building} open={building !== null} onClose={() => setBuilding(null)} onDone={() => { void refresh(); onChanged(); setNotice("Production queued. Assets will appear here for approval."); }} />
    <AdCopyModal asset={copying} brief={copying?.brief_id ? briefById.get(copying.brief_id) ?? null : null} landingUrl={landingUrl} allowedCtas={allowedCtas(template, mirrorsTemplate)} open={copying !== null} onClose={() => setCopying(null)} onSaved={() => { setNotice("Ad copy saved. This asset is in the next Meta build."); void refresh(); }} />
    <MediaDetailModal asset={preview} url={preview ? urls.get(preview.storage_path) : undefined} open={preview !== null} onClose={() => setPreview(null)} />
  </>;

  const v2AssetActions = (asset: CampaignAsset) => <div className="flex flex-wrap gap-2">
    {asset.review_status === "pending" && <>
      <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void act(() => supabase.rpc("review_media_asset", { p_asset_id: asset.id, p_decision: "approved" }), "Asset approved. Ready to distribute.", { id: asset.id, action: "approve" })}>Approve</button>
      <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => { setRejecting(asset); setReason(""); }}>Reject</button>
    </>}
    {asset.review_status === "approved" && asset.media_type === "image" && asset.content_format !== "carousel" && <button type="button" className={buttonClass} onClick={() => setCopying(asset)}>{hasAdCopy(asset) ? "Edit ad copy" : "Write ad copy"}</button>}
    <RegenerateAction assetId={asset.id} hasBrief={Boolean(asset.brief_id && briefById.has(asset.brief_id))} isRejected={asset.review_status === "rejected"} onDone={() => { void refresh(); onChanged(); }} onError={setError} onNotice={setNotice} />
  </div>;

  const v2Preview = (asset: CampaignAsset | undefined) => {
    if (!asset) return <span className="text-muted-foreground">Awaiting asset</span>;
    const url = urls.get(asset.storage_path);
    return <button type="button" onClick={() => setPreview(asset)} aria-label={`Preview ${asset.title ?? "asset"}`}>
      {asset.media_type === "image" && url ? <img src={url} alt={asset.title ?? "Campaign asset"} className="h-16 w-24 rounded object-cover" />
        : asset.media_type === "video" && url ? <video src={url} className="h-16 w-24 rounded object-cover" muted preload="metadata" />
          : <span className="text-brand-strong">Preview {asset.media_type}</span>}
    </button>;
  };

  const packageForAsset = (asset: CampaignAsset): string => {
    const manifestId = artifactPackages.assets.get(asset.id)
      ?? (asset.brief_id ? artifactPackages.briefs.get(asset.brief_id) : undefined);
    return manifestId ? `Package v${artifactPackages.versions.get(manifestId) ?? "unknown"}` : "Package not version-bound";
  };

  if (layout === "v2") return <section className="mt-4 space-y-3" aria-label="Campaign content production">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-semibold">Content production</h3><p className="text-xs text-muted-foreground">{ready} ready to distribute · {contentCount} planned · {ideas.length} ideas</p></div><button type="button" className={buttonClass} onClick={() => void refresh()}>Refresh content</button></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-brand-strong">{notice}</p>}
    {contentCount > 0 && builtAt && !contentIdeasGeneratedAt && <button type="button" className={buttonClass} disabled={busy !== null || loading} onClick={() => void act(() => supabase.rpc("enqueue_agent_job", { p_agent_key: "campaign_plan", p_client_id: clientId, p_input_table: "client_campaigns", p_input_id: campaignId }), "Queued campaign ideas.", { id: campaignId, action: "plan" })}>Generate campaign ideas</button>}
    {contentCount > 0 && !builtAt && <p className="text-xs text-muted-foreground">Run the planner to generate campaign content.</p>}
    {loading ? <p className="text-sm text-muted-foreground">Loading content…</p> : <div className="overflow-x-auto rounded-lg border border-border bg-card"><table className="w-full text-left text-sm"><thead className="border-b border-border bg-muted/40"><tr><th className="p-3">Content piece</th><th className="p-3">Preview</th><th className="p-3">Stage</th><th className="p-3">Brief</th><th className="p-3">Actions</th></tr></thead><tbody>
      {ideas.map((idea) => {
        const linkedBriefs = briefsByIdea.get(idea.id) ?? [];
        const linkedAssets = linkedBriefs.flatMap((brief) => assetsByBrief.get(brief.id) ?? []) as CampaignAsset[];
        const newest = linkedAssets[linkedAssets.length - 1];
        const open = expanded.has(idea.id);
        return <Fragment key={idea.id}><tr className="border-b border-border align-top"><td className="p-3"><button type="button" className="font-medium text-brand-strong hover:underline" aria-expanded={open} onClick={() => setExpanded((current) => { const next = new Set(current); if (open) next.delete(idea.id); else next.add(idea.id); return next; })}>{idea.title} {open ? "▾" : "▸"}</button><span className="block text-xs text-muted-foreground">{formatLabel(idea.content_format)} · {idea.media_type}</span></td><td className="p-3">{v2Preview(newest)}</td><td className="p-3 capitalize">{newest ? `Asset · ${newest.review_status}` : linkedBriefs.length ? `Brief · ${linkedBriefs[0].status.replaceAll("_", " ")}` : `Idea · ${idea.status.replaceAll("_", " ")}`}</td><td className="p-3">{linkedBriefs[0] ? <button type="button" className={buttonClass} onClick={() => setViewing(linkedBriefs[0])}>Brief</button> : "—"}</td><td className="p-3"><button type="button" className={buttonClass} aria-expanded={openAssetActions === idea.id} onClick={() => setOpenAssetActions(openAssetActions === idea.id ? null : idea.id)}>Actions</button>{openAssetActions === idea.id && <div className="mt-2 flex flex-wrap gap-2">{idea.status === "draft" && <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void act(() => supabase.from("client_ideas").update({ status: "approved" }).eq("id", idea.id).eq("client_id", clientId).eq("campaign_id", campaignId).eq("status", "draft"), "Idea approved.", { id: idea.id, action: "approve" })}>Approve idea</button>}{(idea.status === "draft" || idea.status === "approved") && <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void act(() => supabase.rpc("approve_idea_and_generate_brief", { p_idea_id: idea.id }), "Brief queued.", { id: idea.id, action: "brief" })}>Approve &amp; brief</button>}<button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void deleteIdea(idea)}>Delete idea</button></div>}</td></tr>
          {open && <tr className="border-b border-border bg-muted/20"><td colSpan={5} className="p-3"><p className="text-xs text-muted-foreground">{idea.body ?? idea.source_question ?? "No idea detail recorded."}{idea.strategic_reason && ` · ${idea.strategic_reason}`}</p>{linkedBriefs.length === 0 && <p className="mt-2 text-xs text-muted-foreground">{idea.status === "briefed" ? "Brief being written." : "No brief yet."}</p>}{linkedBriefs.map((brief) => <div key={brief.id} className="mt-3 border-l border-border pl-3"><div className="flex flex-wrap items-center gap-2"><span className="text-xs text-muted-foreground">Brief</span><button type="button" className="text-brand-strong hover:underline" onClick={() => setViewing(brief)}>{brief.title}</button><span className="text-xs text-muted-foreground">{brief.status.replaceAll("_", " ")}</span>{(brief.status === "draft" || brief.status === "approved") && <button type="button" className={buttonClass} onClick={() => setBuilding(brief)}>Approve &amp; Build</button>}</div>{(assetsByBrief.get(brief.id) ?? []).map((asset) => <div key={asset.id} className="mt-2 flex flex-wrap items-center gap-2 border-l border-border pl-3 text-xs"><span>Asset version · {asset.title ?? "Untitled"} · {asset.review_status} · {packageForAsset(asset as CampaignAsset)}</span>{v2Preview(asset)}<button type="button" className={buttonClass} aria-expanded={openAssetActions === asset.id} onClick={() => setOpenAssetActions(openAssetActions === asset.id ? null : asset.id)}>Actions</button>{openAssetActions === asset.id && v2AssetActions(asset as CampaignAsset)}</div>)}</div>)}</td></tr>}
        </Fragment>;
      })}
      {looseBriefs.map((brief) => <tr key={brief.id} className="border-b border-border"><td className="p-3">Unlinked brief · {brief.title}</td><td className="p-3">{v2Preview((assetsByBrief.get(brief.id) ?? [])[0] as CampaignAsset | undefined)}</td><td className="p-3">{brief.status.replaceAll("_", " ")}</td><td className="p-3"><button type="button" className={buttonClass} onClick={() => setViewing(brief)}>Brief</button></td><td className="p-3">{(brief.status === "draft" || brief.status === "approved") && <button type="button" className={buttonClass} onClick={() => setBuilding(brief)}>Approve &amp; Build</button>}{(assetsByBrief.get(brief.id) ?? []).map((asset) => <div key={asset.id} className="mt-2 border-t border-border pt-2"><p className="text-xs">{asset.title ?? "Untitled asset"} · {asset.review_status} · {packageForAsset(asset as CampaignAsset)}</p>{v2AssetActions(asset as CampaignAsset)}</div>)}</td></tr>)}
      {looseAssets.map((asset) => <tr key={asset.id} className="border-b border-border"><td className="p-3">Unlinked asset · {asset.title ?? "Untitled"}<span className="block text-xs text-muted-foreground">{packageForAsset(asset)}</span></td><td className="p-3">{v2Preview(asset)}</td><td className="p-3">{asset.review_status}</td><td className="p-3">—</td><td className="p-3">{v2AssetActions(asset)}</td></tr>)}
      {assets.length === 0 && briefs.length === 0 && ideas.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">No campaign content yet.</td></tr>}
    </tbody></table></div>}
    {rejecting && <div className="rounded-md border border-border p-3"><label className="text-sm">Reason for rejecting {rejecting.title ?? "asset"}<textarea className="mt-2 block w-full rounded-md border border-input bg-background p-2" value={reason} onChange={(event) => setReason(event.target.value)} /></label><div className="mt-2 flex gap-2"><button type="button" className={buttonClass} disabled={busy !== null || !reason.trim()} onClick={() => { const asset = rejecting; void act(() => supabase.rpc("review_media_asset", { p_asset_id: asset.id, p_decision: "rejected", p_reason: reason.trim() }), "Asset rejected with feedback.", { id: asset.id, action: "approve" }); setRejecting(null); }}>Confirm rejection</button><button type="button" className={buttonClass} onClick={() => setRejecting(null)}>Cancel</button></div></div>}
    {modals}
  </section>;

  return <section className="mt-4 space-y-3 border-t border-border pt-4" aria-label="Campaign content production">
    <h4 className="text-sm font-semibold">Content production</h4>
    <p className="text-xs text-muted-foreground">{ready} ready to distribute · {contentCount} pieces planned · {ideas.length} campaign ideas</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-brand-strong">{notice}</p>}
    {contentCount > 0 && builtAt && !contentIdeasGeneratedAt && <div className="rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">Generate the {contentCount} campaign-specific ideas the planner asked for, then brief and produce them here.</p>
      <button type="button" className={`${buttonClass} mt-2`} disabled={busy !== null || loading} onClick={() => void act(() => supabase.rpc("enqueue_agent_job", {
        p_agent_key: "campaign_plan",
        p_client_id: clientId,
        p_input_table: "client_campaigns",
        p_input_id: campaignId,
      }), "Queued. The planner is creating the campaign-specific content ideas now.", { id: campaignId, action: "plan" })}>
        {busyFor(campaignId, "plan") ? "Queueing…" : "Generate campaign ideas"}
      </button>
    </div>}
    {contentCount > 0 && !builtAt && <p className="text-xs text-muted-foreground">Waiting for the planner before content ideas can be generated.</p>}
    <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void refresh()}>Refresh content</button>
    {loading ? <p className="text-xs text-muted-foreground">Loading content…</p> : <>
      {contentCount > 0 && builtAt && ideas.length === 0 && <p className="text-xs text-muted-foreground">No campaign ideas yet.</p>}
      {ideas.map((idea) => {
        const ideaBriefs = briefsByIdea.get(idea.id) ?? [];
        const detailsOpen = expanded.has(idea.id);
        const hasDetails = Boolean(idea.body || idea.source_question || idea.strategic_reason);
        return <div key={idea.id} className="space-y-2 rounded-md border border-border p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h5 className="min-w-0 flex-1">
              <button
                type="button"
                aria-expanded={detailsOpen}
                aria-label={`Details for ${idea.title}`}
                disabled={!hasDetails}
                onClick={() =>
                  setExpanded((previous) => {
                    const next = new Set(previous);
                    if (next.has(idea.id)) next.delete(idea.id);
                    else next.add(idea.id);
                    return next;
                  })
                }
                className="flex w-full items-start gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                    detailsOpen && "rotate-90",
                    !hasDetails && "opacity-30",
                  )}
                />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-card-foreground">{idea.title}</span>
                    {/* The campaign chose the shape when it planned the piece. Showing
                        the media type alone made a carousel indistinguishable from a
                        single image on the page where you review the plan. */}
                    {idea.content_format && idea.content_format !== "single" && (
                      <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
                        {formatLabel(idea.content_format)}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                    {idea.media_type} · {idea.status.replace(/_/g, " ")}
                    {hasDetails ? " · Details" : ""}
                  </span>
                </span>
              </button>
            </h5>
          </div>
          {detailsOpen && hasDetails && (
            <div className="space-y-1 border-t border-border pt-2">
              {idea.source_question && <p className="text-xs text-muted-foreground">{idea.source_question}</p>}
              {idea.body && <p className="text-xs text-muted-foreground">{idea.body}</p>}
              {idea.strategic_reason && <p className="text-xs text-muted-foreground">{idea.strategic_reason}</p>}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {idea.status === "draft" && <>
              <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void act(() => supabase.from("client_ideas").update({ status: "approved" }).eq("id", idea.id).eq("client_id", clientId).eq("campaign_id", campaignId).eq("status", "draft"), "Idea approved.", { id: idea.id, action: "approve" })}>{busyFor(idea.id, "approve") ? "Approving…" : "Approve"}</button>
              <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void act(() => supabase.rpc("approve_idea_and_generate_brief", { p_idea_id: idea.id }), "Approved. The brief agent is writing it now — it appears under this idea in a couple of minutes.", { id: idea.id, action: "brief" })}>{busyFor(idea.id, "brief") ? "Queueing brief…" : "Approve & brief"}</button>
            </>}
            {idea.status === "approved" && <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void act(() => supabase.rpc("approve_idea_and_generate_brief", { p_idea_id: idea.id }), "Brief queued. The brief agent is writing it now — it appears under this idea in a couple of minutes.", { id: idea.id, action: "brief" })}>{busyFor(idea.id, "brief") ? "Queueing brief…" : "Brief"}</button>}
            {/* A briefed idea whose brief has not arrived looks identical to one
                that failed, unless it says which it is. */}
            {idea.status === "briefed" && ideaBriefs.length === 0 && <span className="text-xs text-muted-foreground">Brief being written — this takes a couple of minutes.</span>}
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded text-xs text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy !== null}
              onClick={() => void deleteIdea(idea)}
              aria-label={`Delete ${idea.title}`}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              {busyFor(idea.id, "delete") ? "Deleting…" : "Delete"}
            </button>
          </div>

          {ideaBriefs.map((brief) => {
            const briefAssets = assetsByBrief.get(brief.id) ?? [];
            return <div key={brief.id} className="ml-3 space-y-2 border-l border-border pl-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">Brief</span>
                <button type="button" className="text-sm text-brand-strong hover:underline" onClick={() => setViewing(brief)}>{brief.title}</button>
                <span className="text-xs text-muted-foreground">{brief.status.replace(/_/g, " ")}</span>
                {(brief.status === "draft" || brief.status === "approved") && <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => setBuilding(brief)}>Approve &amp; Build</button>}
              </div>
              {briefAssets.length === 0 && brief.status === "in_production" && <p className="text-xs text-muted-foreground">Asset being produced — it appears here when it is done.</p>}
              {briefAssets.map((asset) => assetRow(asset))}
            </div>;
          })}
        </div>;
      })}

      {/* Work whose idea has gone. Still work somebody did. */}
      {looseBriefs.map((brief) => <div key={brief.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3">
        <span className="text-xs text-muted-foreground">Brief</span>
        <button type="button" className="text-sm text-brand-strong hover:underline" onClick={() => setViewing(brief)}>{brief.title}</button>
        <span className="text-xs text-muted-foreground">{brief.status.replace(/_/g, " ")}</span>
        {(brief.status === "draft" || brief.status === "approved") && <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => setBuilding(brief)}>Approve &amp; Build</button>}
      </div>)}
      {looseAssets.map((asset) => <div key={asset.id} className="rounded-md border border-border p-3">{assetRow(asset)}</div>)}
    </>}
    {rejecting && <div className="rounded-md border border-border p-3">
      <label className="text-sm">Reason for rejecting {rejecting.title ?? "asset"}
        <textarea className="mt-2 block w-full rounded-md border border-input bg-background p-2" value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <button type="button" className={buttonClass} disabled={busy !== null || !reason.trim()} onClick={() => {
        const asset = rejecting;
        void act(() => supabase.rpc("review_media_asset", { p_asset_id: asset.id, p_decision: "rejected", p_reason: reason.trim() }), "Asset rejected with feedback.", { id: asset.id, action: "approve" });
        setRejecting(null);
      }}>Confirm rejection</button>
      <button type="button" className={buttonClass} onClick={() => setRejecting(null)}>Cancel</button>
    </div>}
    {modals}
  </section>;
}
