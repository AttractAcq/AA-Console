import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { AgentActivityBar } from "../../components/agents/AgentActivityBar";
import { AgentSteerForm } from "../../components/forms/AgentSteerForm";
import { useAgentJobs } from "../../lib/useAgentJobs";
import { supabase } from "../../lib/supabase";

type Record_ = {
  id: string;
  item_key: string;
  title: string;
  body: string | null;
  status: string;
  edited_at: string | null;
  updated_at: string;
};

/**
 * The written read of the numbers, produced by the reporting agent.
 *
 * It reads the same metrics_period_summary() the panels do, so the prose
 * and the figures beside it cannot drift apart.
 */
export function CommentaryPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [records, setRecords] = useState<Record_[]>([]);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    const { data } = await supabase
      .from("client_agent_records")
      .select("id, item_key, title, body, status, edited_at, updated_at")
      .eq("client_id", clientId)
      .eq("domain", "reporting")
      .order("item_key");
    setRecords((data ?? []) as Record_[]);
    setLoading(false);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const { inFlight, recentFailures } = useAgentJobs(clientId, refresh);

  const ordered = [
    "headline",
    "what_moved",
    "what_is_working",
    "what_is_not",
    "efficiency",
    "recommendations",
    "gaps",
  ];
  const sorted = [...records].sort(
    (a, b) => ordered.indexOf(a.item_key) - ordered.indexOf(b.item_key),
  );
  const written = sorted.length > 0 ? new Date(sorted[0]!.updated_at) : null;

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div>
      <AgentActivityBar inFlight={inFlight} failures={recentFailures} />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        {written ? (
          <p className="text-xs text-muted-foreground">
            Written {written.toLocaleString()}. Re-run after the next sync to refresh it.
          </p>
        ) : (
          <span />
        )}
        <Button icon={Sparkles} onClick={() => setOpen(true)}>
          {records.length > 0 ? "Rewrite" : "Write commentary"}
        </Button>
      </div>

      {notice && (
        <p role="status" className="mb-4 text-sm text-brand-strong">
          {notice}
        </p>
      )}

      {records.length === 0 ? (
        <EmptyState label="No commentary yet. It reads the metrics already ingested and writes what moved, what it means, and what to change." />
      ) : (
        <div className="space-y-4">
          {sorted.map((record) => (
            <section key={record.id} className="rounded-lg border border-border bg-card p-5">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-card-foreground">{record.title}</h2>
                {record.edited_at && (
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
                    Edited by hand
                  </span>
                )}
              </div>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {record.body ?? "—"}
              </p>
            </section>
          ))}
        </div>
      )}

      <AgentSteerForm
        domain="reporting"
        clientId={clientId}
        open={open}
        onClose={() => setOpen(false)}
        onQueued={() => {
          setNotice("Queued. It reads the ingested metrics and writes back here when it finishes.");
          void refresh();
        }}
      />
    </div>
  );
}
