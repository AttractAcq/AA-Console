import { useCallback, useEffect, useState } from "react";
import { Bot, ExternalLink, FileText, User } from "lucide-react";
import { REVIEW_TONE, shortDate } from "../lib/media";
import type { MediaAsset } from "../lib/media";
import { StatusBadge } from "./MediaCard";
import { supabase } from "../lib/supabase";
import { cn } from "../lib/cn";

type Provenance = {
  briefTitle: string | null;
  briefRef: string | null;
  memberName: string | null;
  generated: boolean;
  conceptModel: string | null;
  imageModel: string | null;
  quality: string | null;
};

/**
 * A single asset, large enough to actually judge.
 *
 * The tile in a library is a thumbnail; deciding whether something is good
 * needs the full thing plus where it came from. Provenance matters most:
 * an asset made by an agent and one uploaded by an editor look identical in
 * the grid and are not the same thing at all.
 */
export function MediaDetailModal({
  asset,
  url,
  body,
  open,
  onClose,
}: {
  asset: MediaAsset | null;
  url?: string;
  body?: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const [provenance, setProvenance] = useState<Provenance | null>(null);

  const load = useCallback(async () => {
    if (!asset) return;
    const [briefRes, memberRes, renderRes] = await Promise.all([
      asset.brief_id
        ? supabase.from("client_briefs").select("title, brief_ref").eq("id", asset.brief_id).maybeSingle()
        : Promise.resolve({ data: null }),
      asset.member_id
        ? supabase.from("team_members").select("name").eq("id", asset.member_id).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from("creative_renders")
        .select("quality, model, generation_id")
        .eq("asset_id", asset.id)
        .maybeSingle(),
    ]);

    const render = renderRes.data as { quality: string; model: string | null; generation_id: string } | null;
    let conceptModel: string | null = null;
    if (render) {
      const { data: gen } = await supabase
        .from("creative_generations")
        .select("concept_model")
        .eq("id", render.generation_id)
        .maybeSingle();
      conceptModel = (gen?.concept_model as string | null) ?? null;
    }

    setProvenance({
      briefTitle: (briefRes.data as { title?: string } | null)?.title ?? null,
      briefRef: (briefRes.data as { brief_ref?: string } | null)?.brief_ref ?? null,
      memberName: (memberRes.data as { name?: string } | null)?.name ?? null,
      generated: Boolean(render),
      conceptModel,
      imageModel: render?.model ?? null,
      quality: render?.quality ?? null,
    });
  }, [asset]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !asset) return null;

  const rows: Array<[string, string | null]> = [
    ["Reference", asset.ref_number],
    ["Type", asset.media_type],
    ["Added", shortDate(asset.created_at)],
    ["From brief", provenance?.briefRef ? `${provenance.briefRef} — ${provenance.briefTitle}` : null],
    ["Made by", provenance?.generated ? null : (provenance?.memberName ?? null)],
    ["Render quality", provenance?.quality ?? null],
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-foreground/50" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={asset.title ?? "Media"}
        className="relative flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lg"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-card-foreground">
              {asset.title ?? "Untitled"}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <StatusBadge status={asset.review_status} tone={REVIEW_TONE[asset.review_status]} />
              {provenance?.generated && (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-brand-strong">
                  <Bot className="h-3 w-3" aria-hidden="true" /> Generated
                </span>
              )}
              {provenance && !provenance.generated && provenance.memberName && (
                <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
                  <User className="h-3 w-3" aria-hidden="true" /> {provenance.memberName}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex items-center justify-center bg-cool-surface p-4">
            {asset.media_type === "image" && url ? (
              <img src={url} alt={asset.title ?? ""} className="max-h-[55vh] w-auto object-contain" />
            ) : asset.media_type === "video" && url ? (
              <video src={url} controls className="max-h-[55vh] w-auto" />
            ) : asset.media_type === "text" ? (
              <div className="max-h-[55vh] w-full overflow-y-auto rounded-md bg-card p-4">
                {body ? (
                  <p className="whitespace-pre-wrap text-sm text-foreground">{body}</p>
                ) : (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <FileText className="h-4 w-4" aria-hidden="true" /> The copy could not be loaded.
                  </p>
                )}
              </div>
            ) : (
              <p className="py-12 text-sm text-muted-foreground">Preview unavailable.</p>
            )}
          </div>

          <dl className="grid gap-x-6 gap-y-2 px-5 py-4 sm:grid-cols-2">
            {rows.map(([label, value]) =>
              value ? (
                <div key={label} className="flex min-w-0 gap-2 text-sm">
                  <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
                  <dd className="min-w-0 break-words capitalize text-card-foreground">{value}</dd>
                </div>
              ) : null,
            )}
          </dl>

          {provenance?.generated && (
            <p className="px-5 pb-4 text-xs text-muted-foreground">
              Written by {provenance.conceptModel ?? "an agent"}
              {provenance.imageModel ? `, rendered by ${provenance.imageModel}` : ""}. The concept and
              every other render of it are on the brief.
            </p>
          )}
        </div>

        {url && (
          <footer className="flex shrink-0 justify-end border-t border-border px-5 py-3">
            {/* The bucket is private, so this is a signed URL and it expires.
                Opening a tab is honest about that; a "download" button that
                dies in an hour is not. */}
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm text-muted-foreground",
                "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              Open the full file
            </a>
          </footer>
        )}
      </div>
    </div>
  );
}
