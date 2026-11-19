import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { supabase } from "../../lib/supabase";

type HeldReturn = {
  id: string;
  kind: "form" | "sales agent";
  at: string;
};

/** Source-owned AAL2 decisions waiting in Sales OS, pending ledger integration. */
export function ArchivedReturnAlerts({ clientId }: { clientId: string }) {
  const [holds, setHolds] = useState<HeldReturn[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState(false);
  const [loadedClientId, setLoadedClientId] = useState<string | null>(null);
  const sequence = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const [forms, conversations] = await Promise.all([
      supabase.from("lead_submissions")
        .select("id,created_at", { count: "exact" })
        .eq("client_id", clientId).eq("status", "received")
        .is("lead_id", null).not("archive_match_lead_id", "is", null)
        .order("created_at", { ascending: false }).limit(21),
      supabase.from("sales_agent_conversations")
        .select("id,started_at", { count: "exact" })
        .eq("client_id", clientId).is("lead_id", null)
        .not("archive_match_lead_id", "is", null)
        .order("started_at", { ascending: false }).limit(21),
      ]);
      if (current !== sequence.current) return;
      setLoadedClientId(clientId);
      if (forms.error || conversations.error) {
        setError(true);
        setHolds([]);
        return;
      }
      setError(false);
      setMore((forms.count ?? forms.data?.length ?? 0)
        + (conversations.count ?? conversations.data?.length ?? 0) > 20);
      setHolds([
        ...(forms.data ?? []).map((row) => ({ id: row.id, kind: "form" as const, at: row.created_at })),
        ...(conversations.data ?? []).map((row) => ({ id: row.id, kind: "sales agent" as const, at: row.started_at })),
      ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20));
    } catch {
      if (current !== sequence.current) return;
      setLoadedClientId(clientId);
      setError(true);
      setHolds([]);
    }
  }, [clientId]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void refresh(); });
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { cancelled = true; window.clearInterval(timer); sequence.current += 1; };
  }, [refresh]);

  if (loadedClientId !== clientId || (!error && holds.length === 0)) return null;
  return <section aria-label="Archived contact returns" className="rounded-xl border border-border bg-card p-4">
    <h3 className="text-sm font-semibold">Archived contacts awaiting identity review</h3>
    {error ? <p role="alert" className="mt-2 text-xs text-destructive">
      Archived contact holds could not be loaded. Check Sales OS Capture and Agents.
    </p> : <>
      <p className="mt-1 text-xs text-muted-foreground">
        These source-owned AAL2 reviews are visible here while canonical Inbox registration is being completed.
      </p>
      <ul className="mt-2 space-y-2 text-sm">{holds.map((hold) => <li key={`${hold.kind}:${hold.id}`}>
        <Link className="text-primary underline"
          to={`/clients/${encodeURIComponent(clientId)}/delivery/sales-os?tab=${hold.kind === "form" ? "capture" : "agents"}`}>
          {hold.kind === "form" ? "Captured form" : "Sales agent conversation"} · review archived contact
        </Link>
        <span className="text-muted-foreground"> · {new Date(hold.at).toLocaleString()}</span>
      </li>)}</ul>
      {more && <p className="mt-2 text-xs text-muted-foreground">More holds are in Sales OS.</p>}
    </>}
  </section>;
}
