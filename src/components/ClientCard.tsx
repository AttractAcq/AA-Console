import { Link } from "react-router-dom";
import type { Client } from "../data/clients";
import { cn } from "../lib/cn";

export function ClientCard({ client }: { client: Client }) {
  return (
    <Link
      to={`/clients/${client.id}/delivery/intelligence`}
      className={cn(
        "flex flex-col gap-4 rounded-lg border border-border bg-card p-5 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      )}
    >
      <div
        className={cn(
          "flex h-11 w-11 items-center justify-center rounded-md text-sm font-semibold",
          client.isInternal
            ? "bg-primary text-primary-foreground"
            : "border border-border bg-cool-surface text-ink-subtle",
        )}
      >
        {client.initials}
      </div>
      <div>
        <p className="text-sm font-semibold text-card-foreground">{client.name}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{client.sector}</p>
      </div>
      <div className="mt-auto flex items-center justify-between pt-2 text-xs">
        <span
          className={cn(
            "rounded-full px-2.5 py-1 font-medium",
            client.isInternal
              ? "bg-primary/10 text-brand-strong"
              : "bg-secondary text-secondary-foreground",
          )}
        >
          {client.tier}
        </span>
        <span className="text-muted-foreground">{client.location}</span>
      </div>
    </Link>
  );
}
