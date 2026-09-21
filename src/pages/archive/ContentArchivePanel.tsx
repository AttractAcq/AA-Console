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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<ArchiveRow | null>(null);

  const load = useCallback(async () => {
    if (!clientId) return;
    setLoading(true);
    setError(null);
    try {
      setRows(await fetchArchive(clientId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the archive.");
    }
    setLoading(false);
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => rows.filter((r) => matchesSearch(r, search)), [rows, search]);

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
          {shown.length === rows.length
            ? `${rows.length} archived`
            : `${shown.length} of ${rows.length}`}
        </span>
      </div>

      {!loading && rows.length === 0 ? (
        <EmptyState label="Nothing archived yet — a piece arrives here once it is promoted: an idea when its brief is written, a brief when its asset is built" />
      ) : (
        <DataTable
          columns={["Reference", "Title", "Format", "Got as far as", "Archived", ""]}
          emptyLabel={loading ? "Loading the archive…" : "Nothing matches that search"}
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
      )}

      <ChainDetailModal row={open} open={open !== null} onClose={() => setOpen(null)} />
    </div>
  );
}
