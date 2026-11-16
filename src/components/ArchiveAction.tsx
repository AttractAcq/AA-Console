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
  clientId,
  table,
  id,
  archived,
  noun,
  onDone,
  onError,
}: {
  /** Exact client scope; omitted only for agency recruitment pages. */
  clientId?: string;
  /** Client tables use the scoped archive RPC; agency pages use their admin policy. */
  table:
    | "client_pages"
    | "client_campaigns"
    | "client_sales_agents"
    | "market_opportunities"
    | "client_agent_records"
    | "lead_magnets";
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
    try {
      if (clientId) {
        const { error } = await supabase.rpc("set_client_archive_v8", {
          p_client_id: clientId, p_table_name: table, p_record_id: id, p_archive: !archived,
        });
        if (error) throw error;
      } else if (table === "client_pages") {
        // Agency recruitment pages have no client_id and retain their
        // existing admin-owned archive path.
        const { data, error } = await supabase.from("client_pages")
          .update({ archived_at: archived ? null : new Date().toISOString() })
          .eq("id", id).is("client_id", null).select("id").single();
        if (error || !data) throw new Error(error?.message ?? "Recruitment page was not archived.");
      } else throw new Error("A client is required for this archive action.");
      onDone();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message
        : cause && typeof cause === "object" && "message" in cause
          ? String(cause.message) : String(cause);
      onError(message);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
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
