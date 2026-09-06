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
  // Rejecting without saying why sends the maker back with nothing to act on,
  // so the reason is asked for rather than left optional.
  const [rejecting, setRejecting] = useState<MediaAsset | null>(null);
  const [reason, setReason] = useState("");

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
        url={preview ? urls.get(preview.storage_path) : undefined}
        open={preview !== null}
        onClose={() => setPreview(null)}
      />
    </div>
  );
}
