import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { TextDraftDialog } from "./TextDraftDialog";
import { DataTable } from "../DataTable";
import { ActionMenu } from "../ActionMenu";
import { BriefDetailModal } from "../briefs/BriefDetailModal";
import { FilterPills } from "../FilterPills";
import { mediaFilters } from "../../data/mediaFilters";
import type { MediaFilterId } from "../../data/mediaFilters";
import { formatLabel } from "../../lib/contentFormat";
import { platformLabel } from "../../lib/postPlatform";
import { fetchClientAssets } from "../../lib/media";
import { useSignedPreviewPaths } from "../../lib/useSignedPreviewPaths";
import type { MediaAsset } from "../../lib/media";
import {
  DELETE_ASSET_WARNING,
  dayOrDash,
  deleteContentAsset,
  deletionSummary,
  setContentArchived,
} from "../../lib/contentRecords";
import { supabase } from "../../lib/supabase";

/**
 * The assets themselves, as a table.
 *
 * One component for two tabs because they are one list cut in two by the one
 * decision that matters:
 *
 *   Create  — an asset exists and nobody has signed it off yet.
 *   Assets  — a person has, so it is cleared to be distributed.
 *
 * Create used to list *briefs* awaiting an asset, which put a piece of work
 * in two places at once: in Briefs because it had no asset, and in Create
 * because it had no asset. A brief with nothing made from it is a brief, and
 * it stays in Briefs until something exists. Creation is started there, with
 * Approve & build.
 *
 * `human_approved_at` is the line rather than `review_status`, because a bot
 * approval sets the status and not the stamp — and the stamp is what
 * schedule_asset insists on before anything can be scheduled. Using the
 * status here would show things in Assets that distribution would then
 * refuse.
 */

type BriefRow = {
  id: string;
  title: string;
  body: string | null;
  media_type: "image" | "text" | "video";
  brief_ref: string | null;
  status: string;
  target_platform: string | null;
  source_idea_id: string | null;
  created_at: string;
};

export function ContentAssetTable({ approved }: { approved: boolean }) {
  const { clientId } = useParams<{ clientId: string }>();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const [activeFilter, setActiveFilter] = useState<MediaFilterId>(mediaFilters[0].id);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [briefs, setBriefs] = useState<ReadonlyMap<string, BriefRow>>(new Map());
  const urls = useSignedPreviewPaths("client-media", assets.map((asset) => asset.render_path || asset.storage_path));
  const [viewing, setViewing] = useState<BriefRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    setLoadError(null);
    try {
      const rows = await fetchClientAssets(clientId, { humanApproved: approved });
      setAssets(rows);

      // The brief carries the destination, and is what "View brief" opens.
      const briefIds = [...new Set(rows.map((row) => row.brief_id).filter((id): id is string => Boolean(id)))];
      if (briefIds.length > 0) {
        const { data, error } = await supabase
          .from("client_briefs")
          .select("id, title, body, media_type, brief_ref, status, target_platform, source_idea_id, created_at")
          .eq("client_id", clientId).in("id", briefIds);
        if (error) throw new Error(error.message);
        setBriefs(new Map(((data ?? []) as BriefRow[]).map((brief) => [brief.id, brief])));
      } else {
        setBriefs(new Map());
      }

    } catch (error) {
      setLoadError(
        "Failed to load assets: " + (error instanceof Error ? error.message : "Unknown query error"),
      );
    } finally {
      setLoading(false);
    }
  }, [clientId, approved]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function approveForDistribution(asset: MediaAsset) {
    if (busy) return;
    setBusy(asset.id);
    setNotice(null);
    try {
      const { error } = await supabase.rpc("review_media_asset", {
        p_asset_id: asset.id,
        p_decision: "approved",
      });
      if (error) throw new Error(error.message);
      setNotice("Approved. It is in Assets now, and can be scheduled from Distribution.");
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  async function archive(asset: MediaAsset) {
    if (busy) return;
    setBusy(asset.id);
    setNotice(null);
    try {
      await setContentArchived("asset", asset.id);
      setNotice("Archived. It is still in the Archive, at the stage it reached.");
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  async function terminate(asset: MediaAsset) {
    if (busy || !window.confirm(DELETE_ASSET_WARNING)) return;
    setBusy(asset.id);
    setNotice(null);
    try {
      setNotice(deletionSummary(await deleteContentAsset(asset.id)));
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  /** Edit and Repurpose both live on their own tab, which owns that work. */
  function openEditTab(asset: MediaAsset) {
    navigate(
      `/clients/${clientId}/delivery/content-production-factory?tab=edit&asset=${asset.id}`,
    );
  }

  const requestedDraft = search.get("draft");
  const draft = assets.find(asset => asset.id === requestedDraft && asset.client_id === clientId && ["image", "text"].includes(asset.media_type));
  const source = draft?.brief_id ? briefs.get(draft.brief_id) : undefined;
  function selectDraft(id: string | null) {
    setSearch(current => {
      const next = new URLSearchParams(current);
      if (id) next.set("draft", id);
      else next.delete("draft");
      return next;
    });
  }

  const shown = assets.filter((asset) => asset.media_type === activeFilter);
  const activeLabel = mediaFilters.find((filter) => filter.id === activeFilter)?.label ?? "";

  if (loadError) {
    return (
      <div role="alert">
        <p>{loadError}</p>
        <button type="button" onClick={() => void refresh()}>Retry</button>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4">
        <FilterPills options={mediaFilters} activeId={activeFilter} onChange={setActiveFilter} />
      </div>
      {notice && <p role="status" className="mb-4 text-sm text-brand-strong">{notice}</p>}

      <DataTable
        columns={[
          "Asset",
          "Preview",
          "Destination",
          "Format",
          "Type",
          approved ? "Approved at" : "Created at",
          "Actions",
        ]}
        emptyLabel={
          loading
            ? "Loading assets…"
            : approved
              ? `No approved ${activeLabel.toLowerCase()} assets yet — approve one on the Create tab`
              : `No ${activeLabel.toLowerCase()} assets made yet — build one from a brief`
        }
        rows={shown.map((asset) => {
          const brief = asset.brief_id ? briefs.get(asset.brief_id) : undefined;
          const editableText = !approved && asset.media_type === "text" && brief && asset.storage_path.startsWith(`${asset.client_id}/generated/`);
          return [
            <span key="t">
              {editableText
                ? <button type="button" onClick={() => selectDraft(asset.id)} className="font-medium text-brand-strong hover:underline">{asset.title ?? "Open draft"}</button>
                : asset.title ?? "Untitled"}
              {asset.ref_number && (
                <span className="block text-xs text-muted-foreground">{asset.ref_number}</span>
              )}
            </span>,
            <AssetPreview key="p" asset={asset} url={urls.get(asset.render_path || asset.storage_path)} />,
            <span key="d">{platformLabel(brief?.target_platform)}</span>,
            <span key="f">{formatLabel(asset.content_format ?? "single")}</span>,
            <span key="m" className="capitalize">{asset.media_type}</span>,
            <span key="c">
              {approved
                ? dayOrDash(asset.human_approved_at)
                : dayOrDash(asset.created_at)}
            </span>,
            <ActionMenu
              key="a"
              name={asset.title ?? asset.ref_number ?? "asset"}
              busy={busy === asset.id}
              items={[
                ...(approved
                  ? []
                  : [{
                      label: "Approve to distribution",
                      busyLabel: "Approving…",
                      onSelect: () => void approveForDistribution(asset),
                    }]),
                ...(brief ? [{ label: "View brief", onSelect: () => setViewing(brief) }] : []),
                ...(editableText
                  ? [{ label: "Edit draft", onSelect: () => selectDraft(asset.id) }]
                  : [{ label: "Edit", onSelect: () => openEditTab(asset) }]),
                { label: "Repurpose", onSelect: () => openEditTab(asset) },
                { label: "Archive", busyLabel: "Archiving…", onSelect: () => void archive(asset) },
                { label: "Delete", destructive: true, busyLabel: "Deleting…", onSelect: () => void terminate(asset) },
              ]}
            />,
          ];
        })}
      />

      {!approved && requestedDraft && !loading && (draft && source
        ? draft.media_type === "image"
          ? <section aria-label="Image draft" className="mt-4 space-y-2">
              <h3>{draft.title ?? "Image draft"}</h3>
              <p>{draft.review_status} · <button className="underline" onClick={() => setViewing(source)}>{source.brief_ref ?? source.title}</button></p>
              {urls.get(draft.storage_path)
                ? <img src={urls.get(draft.storage_path)} alt={draft.title ?? "Draft image"} className="max-h-[70vh] max-w-full" />
                : <p>Image preview unavailable.</p>}
              <button onClick={() => selectDraft(null)}>Close draft</button>
            </section>
          : <TextDraftDialog key={draft.id} asset={draft} brief={source} onClose={() => selectDraft(null)} />
        : <p role="status">This draft is unavailable for the selected client.</p>)}
      <BriefDetailModal brief={viewing} open={viewing !== null} onClose={() => setViewing(null)} />
    </div>
  );
}

/**
 * Small enough to scan a column of, big enough to recognise the piece.
 *
 * A video gets its own element rather than a poster frame, because an asset
 * with no poster would otherwise be a grey box indistinguishable from a
 * broken one. Text has nothing to show and says so.
 */
function AssetPreview({ asset, url }: { asset: MediaAsset; url: string | undefined }) {
  if (asset.media_type === "text") {
    return <span className="text-xs text-muted-foreground">Text</span>;
  }
  if (!url) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  if (asset.media_type === "video") {
    return (
      <video
        src={url}
        muted
        preload="metadata"
        className="h-12 w-12 rounded border border-border object-cover"
      />
    );
  }
  return (
    <img
      src={url}
      alt={asset.title ?? "Asset preview"}
      loading="lazy"
      className="h-12 w-12 rounded border border-border object-cover"
    />
  );
}
