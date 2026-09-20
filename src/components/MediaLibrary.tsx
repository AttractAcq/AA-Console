import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { FilterPills } from "./FilterPills";
import { EmptyState } from "./EmptyState";
import { MediaCard, StatusBadge } from "./MediaCard";
import { MediaDetailModal } from "./MediaDetailModal";
import { ApprovalActions } from "./ApprovalActions";
import { countFrames } from "../lib/frames";
import { isMultiFrame } from "../lib/contentFormat";
import { RegenerateAction } from "./RegenerateAction";
import { dateSortOptions } from "../data/sortOptions";
import type { SortOptionId } from "../data/sortOptions";
import { REVIEW_TONE, fetchClientAssets, fetchTextBodies, shortDate, signPaths } from "../lib/media";
import type { MediaAsset } from "../lib/media";

/** What this library holds, for a sentence. */
function libraryNoun(
  mediaType: "image" | "text" | "video" | undefined,
  format: "single" | "carousel" | "story",
): string {
  if (format !== "single") return `${format}s`;
  return mediaType === "text" ? "copy" : `${mediaType}s`;
}

function emptyLabel(
  mediaType: "image" | "text" | "video" | undefined,
  format: "single" | "carousel" | "story",
): string {
  const noun = libraryNoun(mediaType, format);
  const note = format !== "single" ? FORMAT_NOTE[format] : SOURCE_NOTE[mediaType ?? "image"];
  return `No ${noun} yet — ${note}`;
}

const FORMAT_NOTE: Record<string, string> = {
  carousel: "these arrive when a carousel brief is built, and hold their frames in order",
  story: "these arrive when a story brief is built, as stills or clips",
};

/** A frame format says how many it has; a single asset says nothing extra. */
function frameMeta(asset: MediaAsset, frames: number | undefined): string {
  const base = `${asset.ref_number ?? "—"} · ${shortDate(asset.created_at)}`;
  if (!isMultiFrame(asset.content_format)) return base;
  return `${base} · ${frames ?? 0} frame${frames === 1 ? "" : "s"}`;
}

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
export function MediaLibrary({
  mediaType,
  contentFormat = "single",
}: {
  mediaType?: "image" | "text" | "video";
  /** Frame formats have their own libraries; the plain ones ask for single. */
  contentFormat?: "single" | "carousel" | "story";
}) {
  const { clientId } = useParams<{ clientId: string }>();
  const [sort, setSort] = useState<SortOptionId>(dateSortOptions[0].id);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [bodies, setBodies] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<MediaAsset | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [frameCounts, setFrameCounts] = useState<Map<string, number>>(new Map());

  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
    if (!clientId) {
      setLoading(false);
      return;
    }
    const rows = await fetchClientAssets(clientId, {
      ...(mediaType ? { mediaType } : {}),
      contentFormat,
      ascending: sort === "oldest",
    });
    setAssets(rows);
    const signed = await signPaths("client-media", rows.map((r) => r.storage_path));
    setUrls(signed);

    // A text asset's file IS the content, so fetch it. Capped and
    // best-effort: one unreadable file must not blank the whole library.
    if (mediaType === "text") {
      setBodies(await fetchTextBodies(rows, signed));
    }
    setFrameCounts(await countFrames(rows.map((r) => r.id)));
    setLoading(false);
    } catch (error) {
      setLoadError("Failed to load media: " + (error instanceof Error ? error.message : (error as { message?: string })?.message ?? "Unknown query error"));
    } finally {
      setLoading(false);
    }
  }, [clientId, mediaType, contentFormat, sort]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loadError) return <div role="alert"><p>{loadError}</p><button type="button" onClick={() => void refresh()}>Retry</button></div>;

  return (
    <div>
      <div className="mb-4">
        <FilterPills options={dateSortOptions} activeId={sort} onChange={setSort} />
      </div>

      {actionError && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {actionError}
        </p>
      )}

      {notice && <p className="mb-3 text-sm text-brand-strong">{notice}</p>}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading {libraryNoun(mediaType, contentFormat)}…</p>
      ) : assets.length === 0 ? (
        <EmptyState label={emptyLabel(mediaType, contentFormat)} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {assets.map((asset) => (
            <MediaCard
              key={asset.id}
              mediaType={asset.media_type}
              url={urls.get(asset.storage_path)}
              body={bodies.get(asset.id)}
              title={asset.title ?? "Untitled"}
              meta={frameMeta(asset, frameCounts.get(asset.id))}
              onOpen={() => setOpen(asset)}
              badge={
                <StatusBadge status={asset.review_status} tone={REVIEW_TONE[asset.review_status]} />
              }
              actions={
                asset.review_status === "pending" ? (
                  <ApprovalActions
                    assetId={asset.id}
                    title={asset.title ?? "Untitled"}
                    onDone={() => void refresh()}
                    onError={setActionError}
                  />
                ) : (
                  // Any decided asset can be built again. A rejected one is
                  // the obvious case; an approved one that is nearly right is
                  // the common one.
                  <RegenerateAction
                    assetId={asset.id}
                    hasBrief={Boolean(asset.brief_id)}
                    isRejected={asset.review_status === "rejected"}
                    onDone={() => void refresh()}
                    onError={setActionError}
                    onNotice={setNotice}
                  />
                )
              }
            />
          ))}
        </div>
      )}

      <MediaDetailModal
        asset={open}
        url={open ? urls.get(open.storage_path) : undefined}
        body={open ? bodies.get(open.id) : undefined}
        open={open !== null}
        onClose={() => setOpen(null)}
      />
    </div>
  );
}
