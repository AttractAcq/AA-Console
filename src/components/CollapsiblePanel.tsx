import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../lib/cn";

/** Independently collapsible section; opening a page always starts closed. */
export function CollapsiblePanel({ title, badge, children, className }: {
  title: string;
  badge?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section className={cn("self-start rounded-lg border border-border bg-card p-5", className)}>
      <h2>
        <button type="button" aria-expanded={open} aria-controls={id}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center gap-3 rounded text-left text-sm font-semibold text-card-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="flex-1">{title}</span>
          {badge}
          <ChevronDown aria-hidden="true" className={cn("h-4 w-4 shrink-0 transition-transform", !open && "-rotate-90")} />
        </button>
      </h2>
      <div id={id} hidden={!open} className="mt-3">{children}</div>
    </section>
  );
}
