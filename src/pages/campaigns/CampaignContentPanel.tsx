import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";
import { ApproveAndBuildModal } from "../../components/briefs/ApproveAndBuildModal";
import { BriefDetailModal } from "../../components/briefs/BriefDetailModal";
import { MediaDetailModal } from "../../components/MediaDetailModal";
import { signPaths, type MediaAsset } from "../../lib/media";

type Idea = Database["public"]["Tables"]["client_ideas"]["Row"];
type Brief = Database["public"]["Tables"]["client_briefs"]["Row"];
const buttonClass = "rounded-md border border-border px-2.5 py-1 text-xs font-medium text-card-foreground hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

type BusyAction = "approve" | "brief" | "plan";

export function CampaignContentPanel({ clientId, campaignId, contentCount, builtAt, contentIdeasGeneratedAt, onChanged, refreshToken }: {
  clientId: string;
  campaignId: string;
  contentCount: number;
  builtAt: string | null;
  contentIdeasGeneratedAt: string | null;
  onChanged: () => void;
  refreshToken?: unknown;
}) {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
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

  const refresh = useCallback(async () => {
    try {
      const [ideaRows, links] = await Promise.all([
        supabase.from("client_ideas").select("*").eq("client_id", clientId).eq("campaign_id", campaignId).order("campaign_position", { ascending: true }),
        supabase.from("campaign_artifacts").select("brief_id, asset_id").eq("client_id", clientId).eq("campaign_id", campaignId).eq("kind", "content"),
      ]);
      if (ideaRows.error) throw ideaRows.error;
      if (links.error) throw links.error;
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
      const rows = [...new Map([...(byBrief.data ?? []), ...(direct.data ?? [])].map((asset) => [asset.id, asset])).values()] as MediaAsset[];
      setIdeas((ideaRows.data ?? []) as Idea[]);
      setBriefs(briefRows.data ?? []);
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
  const assetRow = (asset: MediaAsset) => (
    <div key={asset.id} className="flex flex-wrap items-center gap-2">
      <button type="button" className="text-sm text-brand-strong hover:underline" onClick={() => setPreview(asset)}>
        Preview {asset.title ?? "asset"}
      </button>
      <span className="text-xs text-muted-foreground">
        {asset.review_status === "approved" ? "Ready to distribute" : asset.review_status === "pending" ? "Awaiting approval" : "Rejected"}
      </span>
      {asset.review_status === "pending" && <>
        <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void act(() => supabase.rpc("review_media_asset", { p_asset_id: asset.id, p_decision: "approved" }), "Asset approved. Ready to distribute.", { id: asset.id, action: "approve" })}>Approve asset</button>
        <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => { setRejecting(asset); setReason(""); }}>Reject asset</button>
      </>}
    </div>
  );

  return <section className="mt-4 space-y-3 border-t border-border pt-4" aria-label="Campaign content production">
    <h4 className="text-sm font-semibold">Content production</h4>
    <p className="text-xs text-muted-foreground">{ready} ready to distribute · {contentCount} pieces planned · {ideas.length} campaign ideas</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-brand-strong">{notice}</p>}
    {contentCount > 0 && builtAt && !contentIdeasGeneratedAt && ideas.length === 0 && <div className="rounded-md border border-border p-3">
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
        return <div key={idea.id} className="space-y-2 rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-card-foreground">{idea.title}</span>
            <span className="text-xs text-muted-foreground">{idea.media_type}</span>
            <span className="text-xs text-muted-foreground">{idea.source_question}</span>
            <span className="text-xs text-muted-foreground">{idea.status.replace(/_/g, " ")}</span>
          </div>
          {idea.body && <p className="text-xs text-muted-foreground">{idea.body}</p>}
          <div className="flex flex-wrap items-center gap-2">
            {idea.status === "draft" && <>
              <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void act(() => supabase.from("client_ideas").update({ status: "approved" }).eq("id", idea.id).eq("client_id", clientId).eq("campaign_id", campaignId).eq("status", "draft"), "Idea approved.", { id: idea.id, action: "approve" })}>{busyFor(idea.id, "approve") ? "Approving…" : "Approve"}</button>
              <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void act(() => supabase.rpc("approve_idea_and_generate_brief", { p_idea_id: idea.id }), "Approved. The brief agent is writing it now — it appears under this idea in a couple of minutes.", { id: idea.id, action: "brief" })}>{busyFor(idea.id, "brief") ? "Queueing brief…" : "Approve & brief"}</button>
            </>}
            {idea.status === "approved" && <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void act(() => supabase.rpc("approve_idea_and_generate_brief", { p_idea_id: idea.id }), "Brief queued. The brief agent is writing it now — it appears under this idea in a couple of minutes.", { id: idea.id, action: "brief" })}>{busyFor(idea.id, "brief") ? "Queueing brief…" : "Brief"}</button>}
            {/* A briefed idea whose brief has not arrived looks identical to one
                that failed, unless it says which it is. */}
            {idea.status === "briefed" && ideaBriefs.length === 0 && <span className="text-xs text-muted-foreground">Brief being written — this takes a couple of minutes.</span>}
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
    <BriefDetailModal brief={viewing} open={viewing !== null} onClose={() => setViewing(null)} />
    <ApproveAndBuildModal brief={building} open={building !== null} onClose={() => setBuilding(null)} onDone={() => { void refresh(); onChanged(); setNotice("Production queued. Assets will appear here for approval."); }} />
    <MediaDetailModal asset={preview} url={preview ? urls.get(preview.storage_path) : undefined} open={preview !== null} onClose={() => setPreview(null)} />
  </section>;
}
