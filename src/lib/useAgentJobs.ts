import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";

export type LiveJob = {
  id: string;
  agent_key: string;
  status: string;
  attempts: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

const IN_FLIGHT = ["queued", "claimed", "running"];

/**
 * Watches this client's agent jobs and tells the page when something
 * finishes.
 *
 * Agent work takes minutes, and without this the console gave no signal at
 * all: a job would run, write its output, and the page would still be
 * showing the state from before the click. Realtime is the primary signal;
 * the poll is a fallback for when the socket cannot connect, and it only
 * runs while something is actually in flight.
 */
export function useAgentJobs(clientId: string | undefined, onSettled?: () => void) {
  const [jobs, setJobs] = useState<LiveJob[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Keep the callback in a ref so a parent re-render does not tear down
  // and rebuild the realtime subscription on every keystroke.
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoaded(true);
      return;
    }
    const { data } = await supabase
      .from("agent_jobs")
      .select("id, agent_key, status, attempts, error, created_at, started_at, completed_at")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(25);
    setJobs((data ?? []) as LiveJob[]);
    setLoaded(true);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live updates.
  useEffect(() => {
    if (!clientId) return;
    const channel = supabase
      .channel(`client-jobs:${clientId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "agent_jobs", filter: `client_id=eq.${clientId}` },
        (payload) => {
          const next = payload.new as LiveJob | undefined;
          void refresh();
          // A job reaching a terminal state means new rows exist for the
          // page to show.
          if (next && (next.status === "completed" || next.status === "failed")) {
            settledRef.current?.();
          }
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [clientId, refresh]);

  // Fallback poll, only while work is outstanding.
  const inFlight = jobs.filter((j) => IN_FLIGHT.includes(j.status));
  const inFlightCount = inFlight.length;
  useEffect(() => {
    if (inFlightCount === 0) return;
    const interval = setInterval(() => void refresh(), 6000);
    return () => clearInterval(interval);
  }, [inFlightCount, refresh]);

  // Anything that failed since the page was opened is worth surfacing;
  // older failures are history and belong on the dashboard.
  const recentFailures = jobs.filter(
    (j) =>
      j.status === "failed" &&
      j.completed_at !== null &&
      Date.now() - new Date(j.completed_at).getTime() < 30 * 60 * 1000,
  );

  return { jobs, inFlight, recentFailures, loaded, refresh };
}

export function elapsedLabel(job: LiveJob): string {
  const start = new Date(job.started_at ?? job.created_at).getTime();
  const seconds = Math.max(0, Math.round((Date.now() - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function agentLabel(agentKey: string): string {
  return agentKey.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
