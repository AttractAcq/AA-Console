import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { FilterPills } from "../../../components/FilterPills";
import { EmptyState } from "../../../components/EmptyState";
import { MediaCard, StatusBadge } from "../../../components/MediaCard";
import { mediaFilters } from "../../../data/mediaFilters";
import type { MediaFilterId } from "../../../data/mediaFilters";
import { REVIEW_TONE, shortDate, signPaths } from "../../../lib/media";
import type { MediaAsset } from "../../../lib/media";
import { supabase } from "../../../lib/supabase";

/** Everything this member has delivered, across every client. */
export function FinishedWorkSection() {
  const { memberId } = useParams<{ memberId: string }>();
  const [activeFilter, setActiveFilter] = useState<MediaFilterId>(mediaFilters[0].id);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!memberId) {
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from("client_media_assets")
      .select(
        "id, client_id, brief_id, ref_number, media_type, title, storage_path, review_status, member_id, created_at",
      )
      .eq("member_id", memberId)
      .eq("media_type", activeFilter)
      .order("created_at", { ascending: false });
    const rows = (data ?? []) as MediaAsset[];
    setAssets(rows);
    setUrls(await signPaths("client-media", rows.map((r) => r.storage_path)));
    setLoading(false);
  }, [memberId, activeFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeLabel = mediaFilters.find((f) => f.id === activeFilter)?.label ?? "";

  return (
    <div>
      <div className="mb-4">
        <FilterPills options={mediaFilters} activeId={activeFilter} onChange={setActiveFilter} />
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading submissions…</p>
      ) : assets.length === 0 ? (
        <EmptyState label={`No ${activeLabel.toLowerCase()} submissions yet`} />
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
            />
          ))}
        </div>
      )}
    </div>
  );
}
