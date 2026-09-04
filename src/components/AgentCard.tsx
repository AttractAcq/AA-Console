import { Link } from "react-router-dom";
import type { Agent } from "../data/agents";
import { cn } from "../lib/cn";

export function AgentCard({ agent }: { agent: Agent }) {
  return (
    <Link
      to={`/team/agents/${agent.id}/overview`}
      className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-md border border-border bg-cool-surface text-sm font-semibold text-ink-subtle">
        {agent.initials}
      </div>
      <p className="text-sm font-semibold text-card-foreground">{agent.name}</p>
      <span
        className={cn(
          "w-fit rounded-full px-2.5 py-1 text-xs font-medium",
          agent.status === "Active"
            ? "bg-primary/10 text-brand-strong"
            : "bg-secondary text-secondary-foreground",
        )}
      >
        {agent.status}
      </span>
    </Link>
  );
}
