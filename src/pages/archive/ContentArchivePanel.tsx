import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Search } from "lucide-react";
import { DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { fetchArchive, matchesSearch, stageLabel } from "../../lib/contentChain";
import type { ArchiveRow } from "../../lib/contentChain";
import { formatLabel } from "../../lib/contentFormat";
import { shortDate } from "../../lib/media";
import { ChainDetailModal } from "./ChainDetailModal";
import { supabase } from "../../lib/supabase";
import { setContentArchived } from "../../lib/contentRecords";

type UnlinkedRecord = {
  id: string;
  client_id: string;
  record_kind: "idea" | "asset";
  reference: string | null;
  title: string | null;
  media_type: string;
  status: string;
  archived_at: string;
  detail: string | null;
  brief_id: string | null;
};

async function fetchUnlinked(clientId: string): Promise<UnlinkedRecord[]> {
  const { data, error } = await supabase
    .from("content_archive_unlinked")
    .select("*")
    .eq("client_id", clientId)
    .order("archived_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as UnlinkedRecord[];
}

/**
 * Everything that has finished being worked on, by reference.
 *
 * The working lists hold work. This holds record — 33 ideas whose brief is
 * written and 26 briefs whose asset is built, which were making the Ideation
 * and Briefs pages unreadable while being finished with.
 *
 * Nothing here is a copy. archived_at is a stamp on the same row, so opening
 * a chain reads the original records rather than a snapshot of them that
 * started drifting the day somebody fixed a typo in a title.
 */
export function ContentArchivePanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [rows, setRows] = useState<ArchiveRow[]>([]);
  const [unlinked, setUnlinked] = useState<UnlinkedRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<ArchiveRow | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!clientId) return;
    setLoading(true);
    setError(null);
    try {
      const [chains, records] = await Promise.all([fetchArchive(clientId), fetchUnlinked(clientId)]);
      setRows(chains);
      setUnlinked(records);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the archive.");
    }
    setLoading(false);
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => rows.filter((r) => matchesSearch(r, search)), [rows, search]);
  const shownUnlinked = useMemo(() => {
    const term = search.trim().toLowerCase();
    return unlinked.filter((record) =>
      !term || [record.reference, record.title, record.record_kind, record.detail]
        .some((value) => (value ?? "").toLowerCase().includes(term)),
    );
  }, [unlinked, search]);

  const restore = async (record: UnlinkedRecord) => {
    setRestoring(record.id);
    setRestoreError(null);
    try {
      await setContentArchived(record.record_kind, record.id, false);
      await load();
    } catch (e) {
      setRestoreError(e instanceof Error ? e.message : "Could not restore that record.");
    } finally {
      setRestoring(null);
    }
  };

  if (error) {
    return (
      <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-2 text-sm text-brand-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div>
      {restoreError && <p role="alert" className="mb-3 text-sm text-destructive">{restoreError}</p>}
      <div className="mb-4 flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Reference, title or territory"
            aria-label="Search the archive"
            className="w-full rounded-md border border-input bg-background py-2 pl-8 pr-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <span className="text-xs text-muted-foreground">
          {shown.length + shownUnlinked.length === rows.length + unlinked.length
            ? `${rows.length + unlinked.length} archived`
            : `${shown.length + shownUnlinked.length} of ${rows.length + unlinked.length}`}
        </span>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading the archive…</p>
      ) : rows.length === 0 && unlinked.length === 0 ? (
        <EmptyState label="Nothing archived yet. Completed brief chains and manually archived ideas or assets appear here." />
      ) : rows.length > 0 ? (
        <DataTable
          columns={["Reference", "Title", "Format", "Got as far as", "Archived", ""]}
          emptyLabel="Nothing matches that search"
          rows={shown.map((row) => [
            <span key="r" className="font-mono text-xs text-muted-foreground">
              {row.brief_ref}
            </span>,
            <button
              key="t"
              type="button"
              onClick={() => setOpen(row)}
              className="rounded text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {row.title}
              {row.pillar_name && (
                <span className="block text-xs text-muted-foreground">{row.pillar_name}</span>
              )}
            </button>,
            <span key="f" className="text-xs">
              {formatLabel(row.content_format)} · <span className="capitalize">{row.media_type}</span>
            </span>,
            <span key="s" className="text-xs text-muted-foreground">
              {stageLabel(row)}
            </span>,
            <span key="a" className="text-xs text-muted-foreground">
              {shortDate(row.archived_at)}
            </span>,
            <button
              key="o"
              type="button"
              onClick={() => setOpen(row)}
              className="text-sm text-brand-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Open
            </button>,
          ])}
        />
      ) : null}

      {!loading && search.trim() && shown.length === 0 && shownUnlinked.length === 0 &&
        rows.length + unlinked.length > 0 && (
          <p className="text-sm text-muted-foreground">Nothing matches that search.</p>
        )}

      {shownUnlinked.length > 0 && (
        <section className="mt-6" aria-labelledby="unlinked-content-heading">
          <h3 id="unlinked-content-heading" className="mb-2 text-sm font-semibold">
            Archived outside a completed chain
          </h3>
          <p className="mb-3 text-xs text-muted-foreground">
            Ideas without a brief and assets whose brief is still active or absent.
          </p>
          <DataTable
            columns={["Reference", "Title and detail", "Record", "Status", "Archived", ""]}
            emptyLabel="No archived records outside completed chains"
            rows={shownUnlinked.map((record) => [
              <span key="r" className="font-mono text-xs text-muted-foreground">{record.reference ?? "—"}</span>,
              <span key="t" className="text-sm">
                {record.title ?? "Untitled"}
                {record.detail && <span className="block whitespace-pre-wrap text-xs text-muted-foreground">{record.detail}</span>}
              </span>,
              <span key="k" className="text-xs capitalize">{record.record_kind} · {record.media_type}</span>,
              <span key="s" className="text-xs capitalize">{record.status.replace(/_/g, " ")}</span>,
              <span key="a" className="text-xs text-muted-foreground">{shortDate(record.archived_at)}</span>,
              <button
                key="x"
                type="button"
                disabled={restoring !== null}
                onClick={() => void restore(record)}
                className="text-sm text-brand-strong hover:underline disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {restoring === record.id ? "Restoring…" : "Restore"}
              </button>,
            ])}
          />
        </section>
      )}

      <ChainDetailModal row={open} open={open !== null} onClose={() => setOpen(null)} />
    </div>
  );
}
