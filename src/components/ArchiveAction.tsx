import { useState } from "react";
import { Archive, ArchiveRestore } from "lucide-react";
import { supabase } from "../lib/supabase";
import { cn } from "../lib/cn";

/**
 * Archive or restore one record, by hand.
 *
 * Content production archives itself — an idea has a brief, a brief has an
 * asset, and a trigger stamps the one behind. Pages, campaigns and sales
 * agents have no such successor: nothing in the records means "this is
 * finished". An end date that passed while a campaign was paused is not a
 * finished campaign, and a sales agent taken off live is usually mid-edit.
 * So these are a decision somebody makes, and this is where they make it.
 *
 * Reversible on purpose, following the agents registry. Nothing is deleted
 * and nothing is copied, so restoring costs nothing and loses nothing —
 * which is what makes archiving safe to do on a hunch.
 */
export function ArchiveAction({
  table,
  id,
  archived,
  noun,
  onDone,
  onError,
}: {
  /** The table holding the record. Each has an admin-all policy. */
  table: "client_pages" | "client_campaigns" | "client_sales_agents";
  id: string;
  archived: boolean;
  /** What to call it in the confirmation, e.g. "campaign". */
  noun: string;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function apply() {
    setBusy(true);
    const { error } = await supabase
      .from(table)
      .update({ archived_at: archived ? null : new Date().toISOString() })
      .eq("id", id);
    setBusy(false);
    setConfirming(false);
    if (error) {
      onError(error.message);
      return;
    }
    onDone();
  }

  if (archived) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => void apply()}
        className="inline-flex items-center gap-1.5 rounded text-sm text-brand-strong hover:underline disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" />
        {busy ? "Restoring…" : "Restore"}
      </button>
    );
  }

  if (confirming) {
    return (
      <span className="inline-flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Archive this {noun}?</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void apply()}
          className="rounded font-medium text-brand-strong hover:underline disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {busy ? "Archiving…" : "Yes"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="rounded text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className={cn(
        "inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground",
        "hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <Archive className="h-3.5 w-3.5" aria-hidden="true" />
      Archive
    </button>
  );
}
