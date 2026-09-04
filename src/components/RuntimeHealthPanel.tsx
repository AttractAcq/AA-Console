import { useCallback, useEffect, useState } from "react";
import { Activity, AlertTriangle, PauseCircle } from "lucide-react";
import { supabase } from "../lib/supabase";
import { cn } from "../lib/cn";

type RuntimeStatus = {
  worker_id: string;
  version: string | null;
  queue_depth: number | null;
  active_jobs: number | null;
  metadata: { enabled?: boolean; concurrency?: number; model?: string } | null;
  reported_at: string;
  is_live: boolean;
};

/**
 * Three states the console must be able to tell apart, which is the whole
 * reason the runtime heartbeats even when its workers are off:
 *   live + enabled   — working
 *   live + disabled  — deployed but switched off (AGENT_RUNTIME_ENABLED)
 *   not live         — crashed, or never deployed
 * Without this, "no jobs are running" looks identical in all three.
 */
export function RuntimeHealthPanel() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const { data } = await supabase
      .from("agent_runtime_status")
      .select("worker_id, version, queue_depth, active_jobs, metadata, reported_at, is_live")
      .order("reported_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    setStatus((data as RuntimeStatus) ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    // The heartbeat writes every 30s; polling at 20s keeps the age
    // readout honest without hammering.
    const interval = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(interval);
  }, [refresh]);

  if (loading) return null;

  const enabled = status?.metadata?.enabled !== false;
  const live = status?.is_live === true;
  const ageSeconds = status
    ? Math.round((Date.now() - new Date(status.reported_at).getTime()) / 1000)
    : null;

  const tone = !status || !live
    ? { cls: "border-destructive/40 bg-destructive/5", icon: AlertTriangle, text: "text-destructive" }
    : enabled
      ? { cls: "border-border bg-card", icon: Activity, text: "text-brand-strong" }
      : { cls: "border-border bg-card", icon: PauseCircle, text: "text-muted-foreground" };

  const Icon = tone.icon;
  const headline = !status
    ? "Runtime has never reported in"
    : !live
      ? "Runtime is not responding"
      : enabled
        ? "Runtime healthy"
        : "Runtime deployed but disabled";

  return (
    <div className={cn("mb-4 rounded-lg border p-4", tone.cls)}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <span className={cn("flex items-center gap-2 text-sm font-medium", tone.text)}>
          <Icon className="h-4 w-4" aria-hidden="true" />
          {headline}
        </span>

        {status && (
          <>
            <Stat label="Queued" value={status.queue_depth ?? 0} />
            <Stat label="Running" value={status.active_jobs ?? 0} />
            <Stat label="Workers" value={status.metadata?.concurrency ?? "—"} />
            <Stat label="Model" value={status.metadata?.model ?? "—"} />
            <Stat
              label="Last beat"
              value={ageSeconds === null ? "—" : `${ageSeconds}s ago`}
            />
            {status.version && <Stat label="Build" value={status.version} mono />}
          </>
        )}
      </div>

      {status && !live && (
        <p className="mt-2 text-sm text-muted-foreground">
          The last heartbeat was {ageSeconds}s ago. Jobs will stay queued until a worker comes
          back — nothing is lost, and leases on any in-flight job expire so they can be reclaimed.
        </p>
      )}
      {status && live && !enabled && (
        <p className="mt-2 text-sm text-muted-foreground">
          The process is alive but <code>AGENT_RUNTIME_ENABLED</code> is false, so no worker loops
          are running. Queued jobs wait.
        </p>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | number;
  mono?: boolean;
}) {
  return (
    <span className="flex items-baseline gap-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-medium text-foreground", mono && "font-mono text-xs")}>
        {value}
      </span>
    </span>
  );
}
