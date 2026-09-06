import { useCallback, useEffect, useState } from "react";
import { Eye } from "lucide-react";
import { useParams } from "react-router-dom";
import { FilterPills } from "../../components/FilterPills";
import { EmptyState } from "../../components/EmptyState";
import { MediaCard, StatusBadge } from "../../components/MediaCard";
import { MediaDetailModal } from "../../components/MediaDetailModal";
import { mediaFilters } from "../../data/mediaFilters";
import type { MediaFilterId } from "../../data/mediaFilters";
import { REVIEW_TONE, fetchClientAssets, shortDate, signPaths } from "../../lib/media";
import type { MediaAsset } from "../../lib/media";
import { supabase } from "../../lib/supabase";

/**
 * The gate between "made" and "shippable". Only approved assets can be
 * scheduled — schedule_asset() refuses anything else.
 */
export function ApprovalsPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [activeFilter, setActiveFilter] = useState<MediaFilterId>(mediaFilters[0].id);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<MediaAsset | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    const rows = await fetchClientAssets(clientId, {
      mediaType: activeFilter,
      reviewStatus: "pending",
    });
    setAssets(rows);
    setUrls(await signPaths("client-media", rows.map((r) => r.storage_path)));
    setLoading(false);
  }, [clientId, activeFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function review(asset: MediaAsset, decision: "approved" | "rejected") {
    setBusyId(asset.id);
    setError(null);
    const { error: rpcError } = await supabase.rpc("review_media_asset", {
      p_asset_id: asset.id,
      p_decision: decision,
      p_reason: undefined,
    });
    setBusyId(null);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    void refresh();
  }

  const activeLabel = mediaFilters.find((f) => f.id === activeFilter)?.label ?? "";

  return (
    <div>
      <div className="mb-4">
        <FilterPills options={mediaFilters} activeId={activeFilter} onChange={setActiveFilter} />
      </div>

      {error && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {error}
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
              url={urls.get(asset.storage_path)}
              title={asset.title ?? "Untitled"}
              meta={`${asset.ref_number ?? "—"} · ${shortDate(asset.created_at)}`}
              badge={
                <StatusBadge status={asset.review_status} tone={REVIEW_TONE[asset.review_status]} />
              }
              actions={
                <>
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
                  <button
                    type="button"
                    disabled={busyId === asset.id}
                    onClick={() => void review(asset, "approved")}
                    className="flex-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={busyId === asset.id}
                    onClick={() => void review(asset, "rejected")}
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

      <MediaDetailModal
        asset={preview}
        url={preview ? urls.get(preview.storage_path) : undefined}
        open={preview !== null}
        onClose={() => setPreview(null)}
      />
    </div>
  );
}
