import type { ReactNode } from "react";
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
  return (
    <section className={cn("rounded-lg border border-border bg-card p-5", className)}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-card-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
