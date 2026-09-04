import { EmptyState } from "./EmptyState";

export function PagePreviewCard() {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-1.5 border-b border-border bg-muted px-3 py-2">
        <span className="h-2 w-2 rounded-full bg-destructive/50" />
        <span className="h-2 w-2 rounded-full bg-chart-4/50" />
        <span className="h-2 w-2 rounded-full bg-chart-2/50" />
      </div>
      <EmptyState label="Page preview" minHeight={160} />
    </div>
  );
}
