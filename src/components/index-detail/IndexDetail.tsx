import type { ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { DataTable } from "../DataTable";
import { Panel } from "../Panel";

/**
 * The one shape the 31 October notes ask for on page after page: a table is the
 * main view, you click a row to see its detail, and the things you can do to a
 * row live on the row.
 *
 * Offer Studio, Website Studio, Lead Magnet Studio, Sales OS and Market
 * Opportunities are each described as "compile the tabs into a single operating
 * page" in exactly this form, and both distribution modules want a log in the
 * same shape. Six or more surfaces, one pattern, so it is written once here.
 *
 * It composes `DataTable` rather than replacing it. That component is already
 * used in 46 files and handles the parts that are genuinely about tables --
 * the header, the empty state, and scrolling a too-wide table inside its own
 * card instead of clipping it on a phone. What was missing, and hand-rolled in
 * at least six panels, is the row-to-detail half.
 *
 * Selection lives in a URL search parameter, which is what
 * MarketOpportunitiesPanel already does. That is deliberate: a detail view you
 * can link to, refresh, and reach with the back button is worth more than one
 * held in component state, and it means a deep link from the Approval Inbox can
 * open the exact row under discussion.
 */
export type IndexColumn<T> = {
  /** Header text. Also the accessible name of the column. */
  label: string;
  /** The cell for one item. Plain text is fine; a node is fine too. */
  cell: (item: T) => ReactNode;
};

export function IndexDetail<T extends { id: string }>({
  title,
  items,
  columns,
  /**
   * The search parameter that holds the open row. Distinct per page so two
   * tables on one screen cannot fight over it.
   */
  paramKey,
  detail,
  rowActions,
  emptyLabel,
  action,
  /** What the right-hand side says before anything is chosen. */
  unselectedLabel = "Choose a row to see its detail.",
  /** How the open row is named in the detail heading and the close button. */
  nameOf,
}: {
  title: string;
  items: readonly T[];
  columns: readonly IndexColumn<T>[];
  paramKey: string;
  detail: (item: T) => ReactNode;
  rowActions?: (item: T) => ReactNode;
  emptyLabel: string;
  action?: ReactNode;
  unselectedLabel?: string;
  nameOf: (item: T) => string;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const openId = searchParams.get(paramKey);
  const open = items.find((item) => item.id === openId) ?? null;

  function show(id: string | null) {
    const next = new URLSearchParams(searchParams);
    if (id === null) next.delete(paramKey);
    else next.set(paramKey, id);
    // replace, so opening and closing rows does not fill the back button with
    // a history entry per click.
    setSearchParams(next, { replace: true });
  }

  const headers = [...columns.map((column) => column.label)];
  if (rowActions) headers.push("");

  const rows = items.map((item) => {
    const cells: ReactNode[] = columns.map((column, index) =>
      // The first cell is the control that opens the row. A button rather than
      // a click handler on the <tr>, so it is reachable by keyboard and
      // announced as the thing it is.
      index === 0 ? (
        <button
          type="button"
          onClick={() => show(item.id === openId ? null : item.id)}
          aria-expanded={item.id === openId}
          aria-label={`${item.id === openId ? "Hide" : "Show"} ${nameOf(item)}`}
          className="text-left font-medium text-brand-strong underline-offset-2 hover:underline"
        >
          {column.cell(item)}
        </button>
      ) : (
        column.cell(item)
      ),
    );
    if (rowActions) cells.push(rowActions(item));
    return cells;
  });

  return (
    <div className="space-y-4">
      <Panel title={title} action={action}>
        <DataTable columns={headers} emptyLabel={emptyLabel} rows={rows} />
      </Panel>

      {open ? (
        <Panel
          title={nameOf(open)}
          action={
            <button
              type="button"
              onClick={() => show(null)}
              className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground"
            >
              Close
            </button>
          }
        >
          {detail(open)}
        </Panel>
      ) : (
        items.length > 0 && (
          <p className="px-1 text-sm text-muted-foreground">{unselectedLabel}</p>
        )
      )}
    </div>
  );
}
