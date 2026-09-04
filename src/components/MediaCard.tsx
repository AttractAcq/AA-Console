import { FileText, Film, ImageOff } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * One asset tile. `url` is a signed URL — private buckets never render
 * without one, so a missing url is a normal state, not an error.
 */
export function MediaCard({
  title,
  meta,
  mediaType,
  url,
  body,
  badge,
  actions,
}: {
  title: string;
  meta?: string;
  mediaType: "image" | "text" | "video";
  url?: string;
  /** Text-only assets (written proof) have a body and no file. */
  body?: string | null;
  badge?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex min-h-[150px] items-center justify-center bg-cool-surface">
        {mediaType === "text" ? (
          <div className="max-h-[150px] w-full overflow-y-auto p-4">
            {body ? (
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{body}</p>
            ) : (
              <FileText className="mx-auto h-6 w-6 text-muted-foreground" aria-hidden="true" />
            )}
          </div>
        ) : url && mediaType === "image" ? (
          <img src={url} alt={title} className="max-h-[180px] w-full object-cover" />
        ) : url && mediaType === "video" ? (
          <video src={url} controls className="max-h-[180px] w-full" />
        ) : (
          <div className="flex flex-col items-center gap-1.5 py-8 text-muted-foreground">
            {mediaType === "video" ? (
              <Film className="h-6 w-6" aria-hidden="true" />
            ) : (
              <ImageOff className="h-6 w-6" aria-hidden="true" />
            )}
            <span className="text-xs">Preview unavailable</span>
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 border-t border-border p-3.5">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-card-foreground">
            {title}
          </p>
          {badge}
        </div>
        {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
        {actions && <div className="mt-auto flex gap-2 pt-1">{actions}</div>}
      </div>
    </div>
  );
}

export function StatusBadge({ status, tone }: { status: string; tone: string }) {
  return (
    <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-medium capitalize", tone)}>
      {status}
    </span>
  );
}
