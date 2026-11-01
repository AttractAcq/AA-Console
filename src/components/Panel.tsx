import { useId, type ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * A titled card that wraps real content. `SectionCard` is the
 * placeholder-only sibling used by the wireframe pages.
 */
export function Panel({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  // A <section> is only announced as a region when it has an accessible name,
  // so the visible heading is tied to it. Without this, a console of a dozen
  // panels per page is one undifferentiated run of content to anything
  // navigating by region, and a test cannot address one panel either.
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className={cn("rounded-lg border border-border bg-card p-5", className)}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id={headingId} className="text-sm font-semibold text-card-foreground">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}
