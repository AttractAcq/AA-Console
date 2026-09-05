import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { agentLabel, elapsedLabel, type LiveJob } from "../../lib/useAgentJobs";
import { cn } from "../../lib/cn";

/**
 * Tells you an agent is working, and that it finished or failed.
 *
 * Without this the console was silent for the two to four minutes an agent
 * takes: you clicked, nothing visibly happened, and the output appeared
 * only if you happened to reload later. Silence and failure looked
 * identical, which is the worst property a long-running action can have.
 */
export function AgentActivityBar({
  inFlight,
  failures,
  className,
}: {
  inFlight: LiveJob[];
  failures: LiveJob[];
  className?: string;
}) {
  // Re-render on a timer so the elapsed counter actually counts.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (inFlight.length === 0) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [inFlight.length]);

  if (inFlight.length === 0 && failures.length === 0) return null;

  return (
    <div className={cn("mb-4 space-y-2", className)}>
      {inFlight.length > 0 && (
        <div
          role="status"
          aria-live="polite"
          className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-4 py-3"
        >
          <span className="flex items-center gap-2 text-sm font-medium text-brand-strong">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {inFlight.length === 1 ? "Agent running" : `${inFlight.length} agents running`}
          </span>
          {inFlight.map((job) => (
            <span key={job.id} className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{agentLabel(job.agent_key)}</span>
              {" · "}
              {job.status === "queued" ? "queued" : elapsedLabel(job)}
            </span>
          ))}
          <span className="text-xs text-muted-foreground">
            Agents take a few minutes. This page updates itself when they finish — you can leave it.
          </span>
        </div>
      )}

      {failures.map((job) => (
        <div
          key={job.id}
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3"
        >
          <span className="flex items-center gap-2 text-sm font-medium text-destructive">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            {agentLabel(job.agent_key)} failed
            {job.attempts > 1 ? ` after ${job.attempts} attempts` : ""}
          </span>
          {job.error && <p className="mt-1 text-sm text-muted-foreground">{job.error}</p>}
        </div>
      ))}
    </div>
  );
}
