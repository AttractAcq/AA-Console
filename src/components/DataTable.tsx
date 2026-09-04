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
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full text-left text-sm">
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
