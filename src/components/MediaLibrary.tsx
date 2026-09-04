import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { FilterPills } from "./FilterPills";
import { EmptyState } from "./EmptyState";
import { MediaCard, StatusBadge } from "./MediaCard";
import { dateSortOptions } from "../data/sortOptions";
import type { SortOptionId } from "../data/sortOptions";
import { REVIEW_TONE, fetchClientAssets, shortDate, signPaths } from "../lib/media";
import type { MediaAsset } from "../lib/media";

/**
 * Image and Video libraries are the same surface with a different
 * media_type. Everything here is written by the Employee console.
 */
export function MediaLibrary({ mediaType }: { mediaType: "image" | "video" }) {
  const { clientId } = useParams<{ clientId: string }>();
  const [sort, setSort] = useState<SortOptionId>(dateSortOptions[0].id);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    const rows = await fetchClientAssets(clientId, {
      mediaType,
      ascending: sort === "oldest",
    });
    setAssets(rows);
    setUrls(await signPaths("client-media", rows.map((r) => r.storage_path)));
    setLoading(false);
  }, [clientId, mediaType, sort]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div>
      <div className="mb-4">
        <FilterPills options={dateSortOptions} activeId={sort} onChange={setSort} />
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading {mediaType}s…</p>
      ) : assets.length === 0 ? (
        <EmptyState
          label={`No ${mediaType}s yet — these arrive when an editor or avatar uploads against a job for this client`}
        />
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
