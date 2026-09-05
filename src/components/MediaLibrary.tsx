import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { FilterPills } from "./FilterPills";
import { EmptyState } from "./EmptyState";
import { MediaCard, StatusBadge } from "./MediaCard";
import { dateSortOptions } from "../data/sortOptions";
import type { SortOptionId } from "../data/sortOptions";
import { REVIEW_TONE, fetchClientAssets, shortDate, signPaths } from "../lib/media";
import type { MediaAsset } from "../lib/media";

const SOURCE_NOTE: Record<string, string> = {
  image: "these arrive when an editor or avatar uploads against a job, or when a brief is built by AI",
  video: "these arrive when an editor or avatar uploads against a job",
  text: "these arrive when a text brief is built by AI, or an editor uploads copy",
};

/**
 * One surface, three media types. Text is the odd one: it is stored as a
 * file like the others, but there is nothing to preview — so its body is
 * fetched and rendered, otherwise every copy asset would be a filename with
 * no way to read it.
 */
export function MediaLibrary({ mediaType }: { mediaType: "image" | "text" | "video" }) {
  const { clientId } = useParams<{ clientId: string }>();
  const [sort, setSort] = useState<SortOptionId>(dateSortOptions[0].id);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [bodies, setBodies] = useState<Map<string, string>>(new Map());
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
    const signed = await signPaths("client-media", rows.map((r) => r.storage_path));
    setUrls(signed);

    // A text asset's file IS the content, so fetch it. Capped and
    // best-effort: one unreadable file must not blank the whole library.
    if (mediaType === "text") {
      const fetched = new Map<string, string>();
      await Promise.all(
        rows.slice(0, 30).map(async (row) => {
          const url = signed.get(row.storage_path);
          if (!url) return;
          try {
            const response = await fetch(url);
            if (response.ok) fetched.set(row.id, (await response.text()).slice(0, 4000));
          } catch {
            // leave it out; the card falls back to its icon
          }
        }),
      );
      setBodies(fetched);
    }
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
          label={`No ${mediaType === "text" ? "copy" : `${mediaType}s`} yet — ${SOURCE_NOTE[mediaType]}`}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {assets.map((asset) => (
            <MediaCard
              key={asset.id}
              mediaType={asset.media_type}
              url={urls.get(asset.storage_path)}
              body={bodies.get(asset.id)}
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
