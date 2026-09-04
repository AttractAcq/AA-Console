import type { LucideIcon } from "lucide-react";

export function ActionCard({
  title,
  icon: Icon,
  onClick,
}: {
  title: string;
  icon?: LucideIcon;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-start gap-3 rounded-lg border border-border bg-card p-5 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      {Icon && (
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-brand-strong">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
      )}
      <span className="text-sm font-semibold text-card-foreground">{title}</span>
    </button>
  );
}
