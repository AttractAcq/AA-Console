import type { ReactNode } from "react";

export function DataTable({
  columns,
  emptyLabel,
  rows,
}: {
  columns: string[];
  emptyLabel: string;
  /** Omit for the placeholder pages, which render an empty state only. */
  rows?: ReactNode[][];
}) {
  return (
    // overflow-x-auto, not overflow-hidden. A table with more columns than a
    // phone is wide used to be clipped at the card's edge with no way to
    // reach the rest — the last columns simply did not exist on mobile, which
    // reads as a zoomed-in page rather than as lost content. It scrolls inside
    // its own card so the page itself never scrolls sideways.
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-max text-left text-sm">
        <thead className="bg-muted">
          <tr>
            {columns.map((column) => (
              <th key={column} className="px-4 py-2.5 font-medium text-muted-foreground">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows && rows.length > 0 ? (
            rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-t border-border">
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="px-4 py-2.5 text-foreground">
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td
                colSpan={columns.length}
                className="px-4 py-16 text-center text-sm text-muted-foreground"
              >
                {emptyLabel}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
