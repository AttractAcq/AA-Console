import { RANGES } from "./useMetrics";
import { cn } from "../../lib/cn";

export function RangePicker({
  value,
  onChange,
  note,
}: {
  value: string;
  onChange: (id: string) => void;
  note?: string;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex gap-1 rounded-lg border border-border p-1">
        {RANGES.map((range) => (
          <button
            key={range.id}
            type="button"
            onClick={() => onChange(range.id)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              value === range.id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {range.label}
          </button>
        ))}
      </div>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}
