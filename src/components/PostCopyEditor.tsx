import { useCallback, useEffect, useMemo, useState } from "react";

import { Modal } from "./Modal";
import {
  captionRemaining,
  checkCopy,
  PLATFORMS,
  platformName,
  type Platform,
} from "../lib/platformLimits";
import { formatHashtags, parseHashtags } from "../lib/postCopy";
import { supabase } from "../lib/supabase";

/**
 * The words that go out with a post, one platform at a time.
 *
 * A reel that goes to Instagram and LinkedIn needs two captions, two hashtag
 * sets and two opinions about where the link belongs. Until migration 145 the
 * only place to put any of that was scheduled_posts.notes, which is one field
 * shared by every platform and read by nobody.
 *
 * Copy saved against the asset is the draft a slot inherits; copy saved here
 * is for this slot. The editor says which it is looking at, because "why did
 * my caption change" is otherwise a mystery with no visible cause.
 *
 * Limits come from the shared module, not from numbers typed in here. The
 * character count is advisory while you type and blocking on save, since a
 * caption the platform will refuse is not worth storing.
 */

export type PostCopyRow = {
  platform: Platform;
  caption: string | null;
  hashtags: string[] | null;
  alt_text: string | null;
  link_url: string | null;
  first_comment: string | null;
  level?: "post" | "asset";
};

type Draft = {
  caption: string;
  hashtags: string;
  alt_text: string;
  link_url: string;
  first_comment: string;
};

const EMPTY: Draft = { caption: "", hashtags: "", alt_text: "", link_url: "", first_comment: "" };

function toDraft(row: PostCopyRow | undefined): Draft {
  if (!row) return EMPTY;
  return {
    caption: row.caption ?? "",
    hashtags: formatHashtags(row.hashtags),
    alt_text: row.alt_text ?? "",
    link_url: row.link_url ?? "",
    first_comment: row.first_comment ?? "",
  };
}

export function PostCopyEditor({
  open,
  onClose,
  scheduledPostId,
  assetId,
  title,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  /** Editing the copy for one slot. Omit to edit the asset's draft instead. */
  scheduledPostId?: string | null;
  assetId?: string | null;
  title?: string | null;
  onSaved?: () => void;
}) {
  const [platform, setPlatform] = useState<Platform>("instagram");
  const [rows, setRows] = useState<PostCopyRow[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!open) return;
    setError(null);
    const query = supabase.from("post_copy").select("platform, caption, hashtags, alt_text, link_url, first_comment");
    const { data, error: loadError } = scheduledPostId
      ? await query.eq("scheduled_post_id", scheduledPostId)
      : await query.eq("asset_id", assetId ?? "");
    if (loadError) {
      setError(loadError.message);
      return;
    }
    setRows((data ?? []) as PostCopyRow[]);
  }, [open, scheduledPostId, assetId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Switching platform swaps the draft for whatever is saved against it.
  useEffect(() => {
    setDraft(toDraft(rows.find((row) => row.platform === platform)));
    setSaved(null);
  }, [platform, rows]);

  const hashtags = useMemo(() => parseHashtags(draft.hashtags), [draft.hashtags]);
  const problems = useMemo(
    () =>
      checkCopy(platform, {
        caption: draft.caption,
        hashtags,
        alt_text: draft.alt_text,
        link_url: draft.link_url,
        first_comment: draft.first_comment,
      }),
    [platform, draft, hashtags],
  );

  const remaining = captionRemaining(platform, draft.caption);

  async function save() {
    if (problems.length > 0) return;
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("set_post_copy", {
      p_platform: platform,
      p_scheduled_post_id: scheduledPostId ?? undefined,
      p_asset_id: scheduledPostId ? undefined : (assetId ?? undefined),
      p_caption: draft.caption || undefined,
      p_hashtags: hashtags,
      p_alt_text: draft.alt_text || undefined,
      p_link_url: draft.link_url || undefined,
      p_first_comment: draft.first_comment || undefined,
    });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setSaved(`${platformName(platform)} copy saved.`);
    await load();
    onSaved?.();
  }

  const field = (key: keyof Draft, label: string, hint?: string, rowsCount?: number) => (
    <label className="block">
      <span className="text-sm font-medium text-card-foreground">{label}</span>
      {rowsCount ? (
        <textarea
          aria-label={label}
          rows={rowsCount}
          value={draft[key]}
          onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
          className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
        />
      ) : (
        <input
          aria-label={label}
          value={draft[key]}
          onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
          className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
        />
      )}
      {hint ? <span className="mt-1 block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );

  return (
    <Modal open={open} onClose={onClose} title={`Post copy${title ? ` — ${title}` : ""}`}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Platform">
          {PLATFORMS.map((p) => {
            const written = rows.some((row) => row.platform === p);
            return (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={p === platform}
                onClick={() => setPlatform(p)}
                className={`rounded-md px-3 py-1.5 text-sm ${
                  p === platform ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"
                }`}
              >
                {platformName(p)}
                {/* A dot rather than a count: which platforms are written is
                    the question, not how much is in each. */}
                {written ? <span aria-label="has copy"> •</span> : null}
              </button>
            );
          })}
        </div>

        {field("caption", "Caption", undefined, 6)}
        <p className={`-mt-2 text-xs ${remaining < 0 ? "text-destructive" : "text-muted-foreground"}`}>
          {remaining < 0
            ? `${Math.abs(remaining).toLocaleString("en-GB")} over the ${platformName(platform)} limit`
            : `${remaining.toLocaleString("en-GB")} characters left`}
        </p>

        {field("hashtags", "Hashtags", "Separated by spaces. The hash is optional.")}
        {field("alt_text", "Alt text", "What the image shows, for anyone who cannot see it.")}
        {field("link_url", "Link")}
        {field("first_comment", "First comment", "Posted straight after, where the platform allows it.", 3)}

        {problems.length > 0 ? (
          <ul className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {saved ? <p className="text-sm text-muted-foreground">{saved}</p> : null}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md bg-secondary px-3 py-2 text-sm">
            Close
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || problems.length > 0}
            className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
          >
            {busy ? "Saving…" : `Save ${platformName(platform)} copy`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
