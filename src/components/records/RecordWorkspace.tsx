import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Play, Pencil } from "lucide-react";
import { Button } from "../Button";
import { EmptyState } from "../EmptyState";
import { FormModal } from "../forms/FormModal";
import type { FieldDef } from "../forms/fields";
import { AgentSteerForm, AGENT_FORMS } from "../forms/AgentSteerForm";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";
import { cn } from "../../lib/cn";

type RecordDomain = Database["public"]["Enums"]["record_domain"];
type JobStatus = Database["public"]["Enums"]["job_status"];

type Template = {
  item_key: string;
  item_type: string;
  title: string;
  description: string | null;
  display_order: number;
};

type Record_ = {
  id: string;
  item_key: string;
  title: string;
  body: string | null;
  period: string | null;
  status: string;
  edited_at: string | null;
};

type Job = {
  id: string;
  status: JobStatus;
  error: string | null;
  created_at: string;
  completed_at: string | null;
};

const JOB_TONE: Record<JobStatus, string> = {
  queued: "bg-secondary text-secondary-foreground",
  claimed: "bg-secondary text-secondary-foreground",
  running: "bg-primary/10 text-brand-strong",
  completed: "bg-primary/10 text-brand-strong",
  failed: "bg-destructive/10 text-destructive",
  cancelled: "bg-secondary text-secondary-foreground",
};

const JOB_LABEL: Record<JobStatus, string> = {
  queued: "Queued — waiting for a worker",
  claimed: "Claimed — starting",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * One component for all seven agent domains. The shape of each page comes
 * from record_templates, so a page renders its labelled cards before any
 * agent has run; bodies are filled in from client_agent_records as they
 * arrive. v5 shipped three parallel copies of this pattern across roughly
 * 2,300 lines — this is the single generic replacement.
 */
export function RecordWorkspace({ domain }: { domain: RecordDomain }) {
  const { clientId } = useParams<{ clientId: string }>();
  const config = AGENT_FORMS[domain];

  const [templates, setTemplates] = useState<Template[]>([]);
  const [records, setRecords] = useState<Record_[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [runOpen, setRunOpen] = useState(false);
  const [editing, setEditing] = useState<{ itemKey: string; title: string; body: string } | null>(
    null,
  );

  const loadTemplates = useCallback(async () => {
    const { data } = await supabase
      .from("record_templates")
      .select("item_key, item_type, title, description, display_order")
      .eq("domain", domain)
      .order("display_order");
    setTemplates((data ?? []) as Template[]);
  }, [domain]);

  const loadRecords = useCallback(async () => {
    if (!clientId) return;
    const { data } = await supabase
      .from("client_agent_records")
      .select("id, item_key, title, body, period, status, edited_at")
      .eq("client_id", clientId)
      .eq("domain", domain)
      .order("display_order");
    setRecords((data ?? []) as Record_[]);
  }, [clientId, domain]);

  const loadJob = useCallback(async () => {
    if (!clientId) return;
    const { data } = await supabase
      .from("agent_jobs")
      .select("id, status, error, created_at, completed_at")
      .eq("client_id", clientId)
      .eq("agent_key", config.agentKey)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    setJob((data as Job) ?? null);
  }, [clientId, config.agentKey]);

  useEffect(() => {
    void (async () => {
      await Promise.all([loadTemplates(), loadRecords(), loadJob()]);
      setLoading(false);
    })();
  }, [loadTemplates, loadRecords, loadJob]);

  // The queue is the source of truth for progress, so watch it rather than
  // polling. A finished job also means new records to pull.
  useEffect(() => {
    if (!clientId) return;
    const channel = supabase
      .channel(`jobs:${domain}:${clientId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "agent_jobs", filter: `client_id=eq.${clientId}` },
        (payload) => {
          const next = payload.new as Job & { agent_key?: string };
          if (next?.agent_key && next.agent_key !== config.agentKey) return;
          setJob(next);
          if (next?.status === "completed") void loadRecords();
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [clientId, domain, config.agentKey, loadRecords]);

  // Campaign Intelligence is the one domain with a period; show the most
  // recent year rather than stacking every year's quarters together.
  const activePeriod = useMemo(() => {
    const periods = records.map((r) => r.period).filter(Boolean) as string[];
    return periods.length > 0 ? periods.sort().at(-1)! : null;
  }, [records]);

  const byKey = useMemo(() => {
    const shown = activePeriod ? records.filter((r) => r.period === activePeriod) : records;
    return new Map(shown.map((r) => [r.item_key, r]));
  }, [records, activePeriod]);

  const filled = templates.filter((t) => byKey.get(t.item_key)?.body).length;

  const editFields: FieldDef[] = [
    { name: "body", label: editing?.title ?? "Content", kind: "textarea", rows: 12, required: true },
  ];

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-end gap-3">
        {job && (
          <span
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium",
              JOB_TONE[job.status],
            )}
          >
            {JOB_LABEL[job.status]}
          </span>
        )}
        {activePeriod && (
          <span className="text-xs text-muted-foreground">Period {activePeriod}</span>
        )}
        <span className="text-xs text-muted-foreground">
          {filled}/{templates.length} generated
        </span>
        <Button icon={Play} onClick={() => setRunOpen(true)}>
          {config.title}
        </Button>
      </div>

      {job?.status === "failed" && job.error && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {job.error}
        </p>
      )}

      {templates.length === 0 ? (
        <EmptyState label="No template defined for this domain" />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {templates.map((t) => {
            const record = byKey.get(t.item_key);
            return (
              <div
                key={t.item_key}
                className="flex flex-col rounded-lg border border-border bg-card p-5"
              >
                <div className="mb-2 flex items-start justify-between gap-2">
                  <h2 className="text-sm font-semibold text-card-foreground">{t.title}</h2>
                  {t.item_type !== "section" && (
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                        t.item_type === "question"
                          ? "bg-primary/10 text-brand-strong"
                          : "bg-secondary text-secondary-foreground",
                      )}
                    >
                      {t.item_type}
                    </span>
                  )}
                </div>

                {t.description && (
                  <p className="mb-3 text-sm text-muted-foreground">{t.description}</p>
                )}

                {record?.body ? (
                  <p className="mb-3 whitespace-pre-wrap text-sm text-muted-foreground">
                    {record.body}
                  </p>
                ) : (
                  <EmptyState label={t.title} minHeight={100} />
                )}

                <div className="mt-auto flex items-center justify-between gap-2 pt-3">
                  <span className="text-xs text-muted-foreground">
                    {record?.edited_at ? "Edited" : record?.body ? "Generated" : "Not generated"}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setEditing({
                        itemKey: t.item_key,
                        title: t.title,
                        body: record?.body ?? "",
                      })
                    }
                    className="flex items-center gap-1.5 rounded text-xs font-medium text-brand-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    Edit
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <AgentSteerForm
        domain={domain}
        clientId={clientId}
        open={runOpen}
        onClose={() => setRunOpen(false)}
        onQueued={loadJob}
      />

      <FormModal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `Edit ${editing.title}` : "Edit"}
        intro="A human edit is stamped and survives the next agent run."
        fields={editFields}
        initialValues={{ body: editing?.body ?? "" }}
        onSubmit={async (v) => {
          if (!clientId || !editing) throw new Error("Nothing to save.");
          const body = (v.body as string).trim();
          const existing = byKey.get(editing.itemKey);

          if (existing) {
            const { error } = await supabase
              .from("client_agent_records")
              .update({ body })
              .eq("id", existing.id);
            if (error) throw error;
            return;
          }

          const template = templates.find((t) => t.item_key === editing.itemKey)!;
          const { error } = await supabase.from("client_agent_records").insert({
            client_id: clientId,
            domain,
            item_key: template.item_key,
            item_type: template.item_type,
            title: template.title,
            display_order: template.display_order,
            period: activePeriod,
            body,
          });
          if (error) throw error;
        }}
        onSaved={loadRecords}
      />
    </div>
  );
}
