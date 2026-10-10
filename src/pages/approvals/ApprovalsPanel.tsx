import { useCallback, useEffect, useState } from "react";
import { Eye } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { FilterPills } from "../../components/FilterPills";
import { EmptyState } from "../../components/EmptyState";
import { MediaCard, StatusBadge } from "../../components/MediaCard";
import { MediaDetailModal } from "../../components/MediaDetailModal";
import { mediaFilters } from "../../data/mediaFilters";
import type { MediaFilterId } from "../../data/mediaFilters";
import { REVIEW_TONE, fetchClientAssets, fetchTextBodies, shortDate, signPaths } from "../../lib/media";
import type { MediaAsset } from "../../lib/media";
import { supabase } from "../../lib/supabase";
import { ContentJourney } from "../../components/ContentJourney";
import { VideoApprovalRoute } from "../../components/VideoApprovalRoute";

/**
 * The gate between "made" and "shippable". Only approved assets can be
 * scheduled — schedule_asset() refuses anything else.
 */
export function ApprovalsPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [activeFilter, setActiveFilter] = useState<MediaFilterId>(mediaFilters[0].id);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [sourceUrls, setSourceUrls] = useState<Map<string, string>>(new Map());
  const [bodies, setBodies] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<MediaAsset | null>(null);
  // Rejecting without saying why sends the maker back with nothing to act on,
  // so the reason is asked for rather than left optional.
  const [rejecting, setRejecting] = useState<MediaAsset | null>(null);
  const [reason, setReason] = useState("");

  const [loadError, setLoadError] = useState<string | null>(null);
  // How many were left out because the engine's own queue owns them.
  const [engineHeld, setEngineHeld] = useState(0);
  const [uncutReels, setUncutReels] = useState(0);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
    if (!clientId) {
      setLoading(false);
      return;
    }
    // Anything still waiting on a person. An asset a bot approved is not
    // pending, and without this it would sit in neither queue: Approvals
    // shows pending, Distribution shows human-approved, and it is neither.
    const [pending, botApproved] = await Promise.all([
      fetchClientAssets(clientId, { mediaType: activeFilter, reviewStatus: "pending" }),
      fetchClientAssets(clientId, {
        mediaType: activeFilter,
        reviewStatus: "approved",
        humanApproved: false,
      }),
    ]);
    // An engine-made asset must not be approved here.
    //
    // review_media_asset signs the asset off and moves nothing. An asset
    // whose slot is waiting on a person would therefore end up approved
    // with the slot still at awaiting_approval, never scheduled and no
    // longer in any queue — the exact fault migration 159 was written to
    // fix, reintroduced by approving it on the wrong tab. approve_slot, on
    // the Engine tab, does both.
    const { data: engineOwned } = await supabase
      .from("content_slots")
      .select("asset_id")
      .eq("client_id", clientId)
      .eq("stage", "awaiting_approval")
      .not("asset_id", "is", null);
    const heldByEngine = new Set(
      ((engineOwned ?? []) as Array<{ asset_id: string | null }>)
        .map((row) => row.asset_id)
        .filter((id): id is string => Boolean(id)),
    );

    const all = [...botApproved, ...pending];
    const rows = all.filter((asset) => !heldByEngine.has(asset.id)
      && (!asset.edit_stage || asset.edit_stage === "review_ready")
      && (asset.content_format !== "reel" || Boolean(asset.render_path)));
    setEngineHeld(all.filter((asset) => heldByEngine.has(asset.id)).length);
    setUncutReels(all.filter((asset) => !heldByEngine.has(asset.id)
      && asset.content_format === "reel" && !asset.render_path).length);
    setAssets(rows);
    const signed = await signPaths("client-media", rows.map((r) =>
      r.content_format === "reel" ? r.render_path ?? "" : r.storage_path));
    setUrls(signed);
    const sourceIds = [...new Set(rows.map((row) => row.source_asset_id).filter((id): id is string => Boolean(id)))];
    if (sourceIds.length) {
      const { data: sources, error: sourceError } = await supabase.from("client_media_assets")
        .select("id, storage_path").in("id", sourceIds);
      if (sourceError) throw sourceError;
      const signedSources = await signPaths("client-media", (sources ?? []).map((source) => source.storage_path));
      setSourceUrls(new Map((sources ?? []).flatMap((source) => {
        const url = signedSources.get(source.storage_path);
        return url ? [[source.id, url] as const] : [];
      })));
    } else setSourceUrls(new Map());
    // Same as Copy library: a text asset's file IS the content. Without this
    // the preview modal only has a signed URL and shows "could not be loaded".
    setBodies(await fetchTextBodies(rows.filter((r) => r.media_type === "text"), signed));
    setLoading(false);
    } catch (error) {
      setLoadError("Failed to load approvals: " + (error instanceof Error ? error.message : (error as { message?: string })?.message ?? "Unknown query error"));
    } finally {
      setLoading(false);
    }
  }, [clientId, activeFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function review(
    asset: MediaAsset,
    decision: "approved" | "rejected",
    why?: string,
  ) {
    setBusyId(asset.id);
    setError(null);
    const { error: rpcError } = await supabase.rpc("review_media_asset", {
      p_asset_id: asset.id,
      p_decision: decision,
      p_reason: why?.trim() || undefined,
    });
    setBusyId(null);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    void refresh();
  }

  const activeLabel = mediaFilters.find((f) => f.id === activeFilter)?.label ?? "";

  if (loadError) return <div role="alert"><p>{loadError}</p><button type="button" onClick={() => void refresh()}>Retry</button></div>;

  return (
    <div>
      <ContentJourney clientId={clientId} current="approval" />
      <div className="mb-4">
        <FilterPills options={mediaFilters} activeId={activeFilter} onChange={setActiveFilter} />
      </div>

      {error && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {engineHeld > 0 && (
        <p className="mb-3 text-sm text-muted-foreground">
          {engineHeld} {engineHeld === 1 ? "piece is" : "pieces are"} waiting on the Engine tab.
          Approving one there schedules the post as well; approving it here would sign the asset off
          and leave the slot where it is.
        </p>
      )}

      {uncutReels > 0 && (
        <p className="mb-3 text-sm text-muted-foreground">
          {uncutReels} reel{uncutReels === 1 ? " is" : "s are"} still in Create / Edit.
          Approvals will show the finished cut when it is rendered.
        </p>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading approvals…</p>
      ) : assets.length === 0 ? (
        <EmptyState label={`No ${activeLabel.toLowerCase()} assets awaiting approval`} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {assets.map((asset) => (
            <MediaCard
              key={asset.id}
              mediaType={asset.media_type}
              url={urls.get(asset.content_format === "reel" ? asset.render_path ?? "" : asset.storage_path)}
              body={bodies.get(asset.id)}
              title={asset.title ?? "Untitled"}
              meta={`${asset.ref_number ?? "—"} · ${shortDate(asset.created_at)}`}
              badge={
                <StatusBadge status={asset.review_status} tone={REVIEW_TONE[asset.review_status]} />
              }
              actions={
                <>
                  {asset.content_format === "reel" && asset.brief_id && (
                    <Link to={`/clients/${clientId}/delivery/media?tab=reel-shots&brief=${encodeURIComponent(asset.brief_id)}`}
                      className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-brand-strong hover:bg-accent">
                      Production history
                    </Link>
                  )}
                  {/* An explicit control rather than a clickable tile: these
                      cards already carry buttons, and a button cannot contain
                      another one. */}
                  <button
                    type="button"
                    onClick={() => setPreview(asset)}
                    aria-label={`Preview ${asset.title ?? "this asset"}`}
                    className="rounded-md border border-border px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Eye className="h-4 w-4" aria-hidden="true" />
                  </button>
                  {asset.media_type === "video" ? <VideoApprovalRoute assetId={asset.id}
                    onFinalApprove={() => review(asset, "approved")} /> : <button
                    type="button"
                    disabled={busyId === asset.id}
                    onClick={() => void review(asset, "approved")}
                    className="flex-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Approve
                  </button>}
                  <button
                    type="button"
                    disabled={busyId === asset.id}
                    onClick={() => {
                      setReason("");
                      setRejecting(asset);
                    }}
                    className="flex-1 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Reject
                  </button>
                </>
              }
            />
          ))}
        </div>
      )}

      {rejecting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close"
            className="absolute inset-0 bg-foreground/40"
            onClick={() => setRejecting(null)}
          />
          <div
            role="dialog"
            aria-modal="true"
            className="relative w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-lg"
          >
            <h2 className="text-base font-semibold text-card-foreground">
              Why is this being rejected?
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {rejecting.ref_number ? `${rejecting.ref_number} — ` : ""}
              {rejecting.title ?? "Untitled"}. Whoever made it sees this, so say what would make it
              right.
            </p>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              autoFocus
              placeholder="The shade guide is out of focus and the practice logo is cropped."
              className="mt-3 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRejecting(null)}
                className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!reason.trim() || busyId === rejecting.id}
                onClick={() => {
                  const asset = rejecting;
                  setRejecting(null);
                  void review(asset, "rejected", reason);
                }}
                className="rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          </div>
        </div>
      )}

      <MediaDetailModal
        asset={preview}
        url={preview ? urls.get(preview.content_format === "reel" ? preview.render_path ?? "" : preview.storage_path) : undefined}
        sourceUrl={preview?.source_asset_id ? sourceUrls.get(preview.source_asset_id) : undefined}
        body={preview ? bodies.get(preview.id) : undefined}
        open={preview !== null}
        onClose={() => setPreview(null)}
      />
    </div>
  );
}
