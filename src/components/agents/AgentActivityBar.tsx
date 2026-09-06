import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { agentLabel, elapsedLabel, type LiveJob } from "../../lib/useAgentJobs";
import { cn } from "../../lib/cn";

const DISMISSED_KEY = "aa:dismissed-agent-failures";

/**
 * Dismissals outlive the component. This bar unmounts whenever the tab
 * changes, so component state alone meant a dismissed error reappeared the
 * moment you navigated — which is worse than not offering dismissal at all.
 * sessionStorage keeps it for the session without hiding a failure forever.
 */
function readDismissed(): Set<string> {
  try {
    const raw = sessionStorage.getItem(DISMISSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function persistDismissed(ids: Set<string>): void {
  try {
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]));
  } catch {
    // Private windows and blocked site data both throw. Dismissal then lasts
    // only as long as the component, which is the old behaviour, not a crash.
  }
}

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
  // Dismissed by id, not by index: the list re-orders as jobs settle, and
  // dismissing "the second one" would then hide whatever moved into that slot.
  const [dismissed, setDismissed] = useState<Set<string>>(readDismissed);

  // Re-render on a timer so the elapsed counter actually counts.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (inFlight.length === 0) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [inFlight.length]);

  const shown = failures.filter((job) => !dismissed.has(job.id));
  const dismiss = (id: string) =>
    setDismissed((prev) => {
      const next = new Set(prev).add(id);
      persistDismissed(next);
      return next;
    });

  if (inFlight.length === 0 && shown.length === 0) return null;

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

      {shown.map((job) => (
        <div
          key={job.id}
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3"
        >
          <div className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-sm font-medium text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              {agentLabel(job.agent_key)} failed
              {/* attempts is now truthful, so this only appears when retries
                  really happened. A non-retryable failure gave up on purpose
                  and says so by saying nothing. */}
              {job.attempts > 1 ? ` after ${job.attempts} attempts` : ""}
            </span>
            {job.error && <p className="mt-1 text-sm text-muted-foreground">{job.error}</p>}
          </div>
          <button
            type="button"
            onClick={() => dismiss(job.id)}
            aria-label={`Dismiss the ${agentLabel(job.agent_key)} failure`}
            className="-mr-1 -mt-1 shrink-0 rounded-md p-1.5 text-destructive/70 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
