import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { supabase } from "../../lib/supabase";

const ROUTES = {
  google_reply_sender: { title: "Google review reply", path: "google-profile?tab=reviews" },
  google_profile_field_writer: { title: "Google profile change", path: "google-profile?tab=location" },
  google_profile_field_reconciler: { title: "Google profile readback", path: "google-profile?tab=location" },
  meta_profile_field_writer: { title: "Meta Page change", path: "meta-profile?tab=profile" },
  meta_profile_field_reconciler: { title: "Meta Page readback", path: "meta-profile?tab=profile" },
} as const;

type HeldJob = { id: string; client_id: string; agent_key: keyof typeof ROUTES; created_at: string };

/** Approved provider work paused by a runtime hold remains visible to its owner. */
export function HeldExternalJobs({ clientId }: { clientId?: string }) {
  const [jobs, setJobs] = useState<HeldJob[]>([]);
  const [error, setError] = useState(false);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const sequence = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    let query = supabase.from("agent_jobs")
      .select("id,client_id,agent_key,created_at")
      .eq("status", "paused")
      .in("agent_key", Object.keys(ROUTES));
    if (clientId) query = query.eq("client_id", clientId);
    const result = await query.order("created_at", { ascending: false }).limit(5);
    if (current !== sequence.current) return;
    if (result.error) {
      setError(true);
    } else {
      setJobs((result.data ?? []).flatMap((row) =>
        row.id && row.client_id && row.created_at && row.agent_key in ROUTES
          && (!clientId || row.client_id === clientId)
          ? [{ id: row.id, client_id: row.client_id,
            agent_key: row.agent_key as HeldJob["agent_key"], created_at: row.created_at }]
          : []));
      setError(false);
    }
    setLoadedScope(clientId ?? "all");
  }, [clientId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { window.clearInterval(timer); sequence.current += 1; };
  }, [refresh]);

  if (loadedScope !== (clientId ?? "all") || (!error && jobs.length === 0)) return null;
  return <section aria-label="Held external jobs" className="rounded-xl border border-border bg-card p-4">
    <h3 className="text-sm font-semibold">Approved external work on hold</h3>
    {error ? <p role="alert" className="mt-2 text-xs text-destructive">Held jobs could not be loaded. Check the owning queues.</p>
      : <ul className="mt-2 space-y-2 text-sm">{jobs.map((job) => <li key={job.id}>
        <Link className="text-primary underline" to={`/clients/${job.client_id}/${ROUTES[job.agent_key].path}`}>
          {ROUTES[job.agent_key].title} · held
        </Link>
        <span className="text-muted-foreground"> · queued {new Date(job.created_at).toLocaleString()}</span>
      </li>)}</ul>}
  </section>;
}
