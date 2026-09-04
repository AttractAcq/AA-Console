import { FileText } from "lucide-react";
import { EmptyState } from "./EmptyState";

export function FileAssetCard({ label, meta }: { label: string; meta?: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border bg-muted px-3 py-2">
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {label}
        </span>
        {meta && <span className="shrink-0 text-xs text-muted-foreground">{meta}</span>}
      </div>
      <EmptyState label={meta ? "Uploaded" : "No file uploaded"} minHeight={140} />
    </div>
  );
}
