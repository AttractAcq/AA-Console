import { cn } from "../lib/cn";

export function FilterPills<TId extends string>({
  options,
  activeId,
  onChange,
}: {
  options: Array<{ id: TId; label: string }>;
  activeId: TId;
  onChange: (id: TId) => void;
}) {
  return (
    <div role="group" aria-label="Filter by type" className="flex flex-wrap gap-2">
      {options.map((option) => {
        const selected = option.id === activeId;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.id)}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              selected
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-secondary-foreground hover:bg-accent",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
