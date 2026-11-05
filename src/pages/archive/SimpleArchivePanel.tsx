import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Search } from "lucide-react";
import { DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { ArchiveAction } from "../../components/ArchiveAction";
import { supabase } from "../../lib/supabase";
import { shortDate } from "../../lib/media";

/**
 * The archive's simple domains: pages, campaigns, sales agents, market
 * opportunities, the intelligence and strategy models, lead magnets, and
 * rejected creative.
 *
 * One component for all of them because they are the same shape: a thing with
 * a name that is no longer live work. Content production earns its own panel —
 * it has a reference that spans six stages and needs them all — but seven
 * near-identical tables would be seven places to fix the same bug.
 *
 * Most rows can be restored. Nothing was copied or deleted to get here, so
 * restoring is just clearing the stamp, which is what makes archiving safe to
 * do without being sure.
 *
 * REJECTED CREATIVE IS THE EXCEPTION, AND IT IS DELIBERATE.
 *
 * It is listed by its rejection, not by an archive stamp, because the notes ask
 * for the what-worked trend — and a trend built only from rejections somebody
 * also remembered to archive is a record of who tidied up. So it has nothing to
 * restore: un-rejecting is a review decision, made where the seat rules and the
 * video sign-off chain live, not a restore button on a filing page. Such a
 * domain says `restorable: false` and gets no action rather than one that would
 * not work.
 */
type Row = {
  id: string;
  title: string | null;
  kind: string;
  status: string;
  archived_at: string;
  [key: string]: unknown;
};

export type ArchiveDomain = {
  /** The view to read. */
  view:
    | "pages_archive"
    | "campaigns_archive"
    | "sales_agents_archive"
    | "opportunities_archive"
    | "agent_models_archive"
    | "lead_magnets_archive"
    | "rejected_assets_archive";
  /** The table to write back to when restoring. Omitted when nothing restores. */
  table?:
    | "client_pages"
    | "client_campaigns"
    | "client_sales_agents"
    | "market_opportunities"
    | "client_agent_records"
    | "lead_magnets";
  noun: string;
  kindLabel: string;
  /** The one number worth showing per domain, and what to call it. */
  metric: { field: string; label: string };
  empty: string;
  /** False where the listing is not an archive stamp and clearing one would do nothing. */
  restorable?: boolean;
  /** An extra column worth a domain its own, e.g. why creative was rejected. */
  extra?: { field: string; label: string };
};

export const ARCHIVE_DOMAINS: Record<string, ArchiveDomain> = {
  pages: {
    view: "pages_archive",
    table: "client_pages",
    noun: "page",
    kindLabel: "Type",
    metric: { field: "revisions", label: "Revisions" },
    empty: "No archived pages. Archive one from the Page Builder when it is finished with.",
  },
  campaigns: {
    view: "campaigns_archive",
    table: "client_campaigns",
    noun: "campaign",
    kindLabel: "Template",
    metric: { field: "pieces", label: "Content" },
    empty: "No archived campaigns. Archive one from Campaigns once it has run.",
  },
  "sales-agents": {
    view: "sales_agents_archive",
    table: "client_sales_agents",
    noun: "sales agent",
    kindLabel: "Role",
    metric: { field: "conversations", label: "Conversations" },
    empty: "No archived sales agents. Archive one from Sales Agents when it is retired.",
  },
  opportunities: {
    view: "opportunities_archive",
    table: "market_opportunities",
    noun: "opportunity",
    kindLabel: "Micro-market",
    // The score it was last given: what it was judged to be worth, rather
    // than merely that it was shelved.
    metric: { field: "score", label: "Score" },
    empty: "No archived opportunities. Archive one from Market Opportunities once it has been decided against or won.",
  },
  models: {
    view: "agent_models_archive",
    table: "client_agent_records",
    noun: "model",
    kindLabel: "Domain",
    // A gestured-at model and a worked-through one are different things to
    // find later, and nothing else in the row says which.
    metric: { field: "words", label: "Words" },
    empty: "No archived models. Archive an ICP, market, competitor, strategy or money-model record when it is superseded.",
  },
  "lead-magnets": {
    view: "lead_magnets_archive",
    table: "lead_magnets",
    noun: "lead magnet",
    kindLabel: "Format",
    metric: { field: "versions", label: "Versions" },
    empty: "No archived lead magnets. Archive one from Lead Magnet Studio when it is finished with.",
  },
  rejected: {
    view: "rejected_assets_archive",
    noun: "rejected asset",
    kindLabel: "Media",
    // How many looks it took. An asset refused on the third review is a
    // different story from one refused flat.
    metric: { field: "reviews", label: "Reviews" },
    extra: { field: "rejection_note", label: "Why" },
    // Listed by its rejection, not by an archive stamp: see the note above.
    restorable: false,
    empty: "No rejected creative. Anything turned down in review appears here with the reason.",
  },
};

export function SimpleArchivePanel({ domain }: { domain: ArchiveDomain }) {
  const { clientId } = useParams<{ clientId: string }>();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    if (!clientId) return;
    setLoading(true);
    setError(null);
    const { data, error: queryError } = await supabase
      .from(domain.view)
      .select("*")
      .eq("client_id", clientId)
      .order("archived_at", { ascending: false });
    if (queryError) setError(queryError.message);
    else setRows((data ?? []) as Row[]);
    setLoading(false);
  }, [clientId, domain.view]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.title, r.kind, r.status].some((f) => String(f ?? "").toLowerCase().includes(q)),
    );
  }, [rows, search]);

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

  if (!loading && rows.length === 0) return <EmptyState label={domain.empty} />;

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <div className="relative max-w-sm flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search archived ${domain.noun}s`}
            aria-label={`Search archived ${domain.noun}s`}
            className="w-full rounded-md border border-input bg-background py-2 pl-8 pr-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <span className="text-xs text-muted-foreground">
          {shown.length === rows.length ? `${rows.length} archived` : `${shown.length} of ${rows.length}`}
        </span>
      </div>

      <DataTable
        columns={[
          "Title",
          domain.kindLabel,
          "Status",
          domain.metric.label,
          ...(domain.extra ? [domain.extra.label] : []),
          "Archived",
          "",
        ]}
        emptyLabel={loading ? "Loading…" : "Nothing matches that search"}
        rows={shown.map((row) => [
          <span key="t" className="text-card-foreground">
            {row.title ?? "Untitled"}
          </span>,
          <span key="k" className="text-xs capitalize text-muted-foreground">
            {String(row.kind).replace(/_/g, " ")}
          </span>,
          <span key="s" className="text-xs capitalize text-muted-foreground">
            {String(row.status).replace(/_/g, " ")}
          </span>,
          <span key="m" className="text-xs text-muted-foreground">
            {String(row[domain.metric.field] ?? 0)}
          </span>,
          ...(domain.extra
            ? [
                <span key="e" className="text-xs text-muted-foreground">
                  {String(row[domain.extra.field] ?? "—")}
                </span>,
              ]
            : []),
          <span key="a" className="text-xs text-muted-foreground">
            {shortDate(row.archived_at)}
          </span>,
          // No action where nothing restores: clearing an archive stamp would
          // not un-reject anything, and a button that does nothing is worse
          // than no button.
          domain.restorable === false || !domain.table ? (
            <span key="x" />
          ) : (
            <ArchiveAction
              key="x"
              table={domain.table}
              id={row.id}
              archived
              noun={domain.noun}
              onDone={() => void load()}
              onError={setError}
            />
          ),
        ])}
      />
    </div>
  );
}
