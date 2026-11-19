import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Play, Pencil } from "lucide-react";
import { CollapsiblePanel } from "../CollapsiblePanel";
import { Button } from "../Button";
import { EmptyState } from "../EmptyState";
import { FormModal } from "../forms/FormModal";
import type { FieldDef } from "../forms/fields";
import { AgentSteerForm, AGENT_FORMS } from "../forms/AgentSteerForm";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";
import { cn } from "../../lib/cn";
import { AgentActivityBar } from "../agents/AgentActivityBar";
import { ArchiveAction } from "../ArchiveAction";
import { useAgentJobs } from "../../lib/useAgentJobs";

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
  item_type: string;
  title: string;
  body: string | null;
  period: string | null;
  display_order: number;
  status: string;
  edited_at: string | null;
  job_id: string | null;
  updated_at: string;
};

type SectionReview = {
  record_id: string;
  review_state: string;
  source_ref: string | null;
  observed_on: string | null;
  confidence: string | null;
  reviewed_at: string | null;
  review_note: string | null;
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
  // Held, not broken. Amber rather than the destructive red a failure
  // gets: the reason will pass on its own and the work is still there.
  paused: "bg-secondary text-secondary-foreground",
  claimed: "bg-secondary text-secondary-foreground",
  running: "bg-primary/10 text-brand-strong",
  completed: "bg-primary/10 text-brand-strong",
  failed: "bg-destructive/10 text-destructive",
  cancelled: "bg-secondary text-secondary-foreground",
};

const JOB_LABEL: Record<JobStatus, string> = {
  queued: "Queued — waiting for a worker",
  // The error column carries why, and resume_paused_jobs re-checks it
  // hourly, so this says "waiting" rather than "stopped".
  paused: "Held — waiting on a cap or a paused agent",
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
  const [reviews, setReviews] = useState<SectionReview[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [editing, setEditing] = useState<{
    itemKey: string; title: string; body: string; recordId: string | null; updatedAt: string | null;
  } | null>(
    null,
  );
  const [reviewing, setReviewing] = useState<Record_ | null>(null);

  const loadTemplates = useCallback(async () => {
    const { data, error } = await supabase
      .from("record_templates")
      .select("item_key, item_type, title, description, display_order")
      .eq("domain", domain)
      .order("display_order");
    if (error) throw error;
    setTemplates((data ?? []) as Template[]);
  }, [domain]);

  const loadRecords = useCallback(async () => {
    if (!clientId) return;
    const { data, error } = await supabase
      .from("client_agent_records")
      .select("id, item_key, item_type, title, body, period, display_order, status, edited_at, job_id, updated_at")
      .eq("client_id", clientId)
      .eq("domain", domain)
      // Archived models live in the Archive (migration 312). This table holds
      // every domain's records, so without the filter a superseded model keeps
      // appearing in the working view it was superseded out of.
      .is("archived_at", null)
      .order("display_order");
    if (error) throw error;
    setRecords((data ?? []) as Record_[]);
  }, [clientId, domain]);

  const loadReviews = useCallback(async () => {
    if (!clientId) return;
    const { data, error } = await supabase.from("model_section_review_state_v7")
      .select("record_id,review_state,source_ref,observed_on,confidence,reviewed_at,review_note")
      .eq("client_id", clientId).eq("domain", domain);
    if (error) throw error;
    setReviews((data ?? []) as SectionReview[]);
  }, [clientId, domain]);

  const loadJob = useCallback(async () => {
    if (!clientId) return;
    const { data, error } = await supabase
      .from("agent_jobs")
      .select("id, status, error, created_at, completed_at")
      .eq("client_id", clientId)
      .eq("agent_key", config.agentKey)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    setJob((data as Job) ?? null);
  }, [clientId, config.agentKey]);

  const loadAll = useCallback(async () => {
    setLoadError(null);
    try {
      await Promise.all([loadTemplates(), loadRecords(), loadReviews(), loadJob()]);
    } catch (error) {
      setLoadError("Failed to load: " + (error instanceof Error ? error.message : (error as { message?: string })?.message ?? "Unknown query error"));
    } finally {
      setLoading(false);
    }
  }, [loadTemplates, loadRecords, loadReviews, loadJob]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

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
          if (next?.status === "completed") void Promise.all([loadRecords(), loadReviews()]);
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [clientId, domain, config.agentKey, loadRecords, loadReviews]);

  // Campaign Intelligence is the one domain with a period; show the most
  // recent year rather than stacking every year's quarters together.
  const activePeriod = useMemo(() => {
    const periods = records.map((r) => r.period).filter(Boolean) as string[];
    return periods.length > 0 ? periods.sort().at(-1)! : null;
  }, [records]);

  const shownRecords = useMemo(
    () =>
      activePeriod
        ? records.filter((r) => r.period === activePeriod || r.period === null)
        : records,
    [records, activePeriod],
  );

  const byKey = useMemo(
    () => new Map(shownRecords.map((r) => [r.item_key, r])),
    [shownRecords],
  );

  // Templates define the sections the agent generates. A valid client record
  // without a template is human-managed reference material and must still be
  // visible in the workspace.
  const displayTemplates = useMemo(() => {
    const templateKeys = new Set(templates.map((t) => t.item_key));

    const references: Template[] = shownRecords
      .filter((record) => !templateKeys.has(record.item_key))
      .map((record) => ({
        item_key: record.item_key,
        item_type: "reference",
        title: record.title,
        description: null,
        display_order: record.display_order,
      }));

    return [...templates, ...references].sort(
      (a, b) => a.display_order - b.display_order,
    );
  }, [templates, shownRecords]);

  const filled = templates.filter((t) => byKey.get(t.item_key)?.body).length;

  const { inFlight: liveJobs, recentFailures: liveFailures } = useAgentJobs(clientId, () => {
    void loadRecords();
    void loadReviews();
    void loadJob();
  });

  const editFields: FieldDef[] = [
    { name: "body", label: editing?.title ?? "Content", kind: "textarea", rows: 12, required: true },
  ];
  const reviewingState = reviews.find((item) => item.record_id === reviewing?.id);

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (loadError) return <div role="alert"><p>{loadError}</p><button type="button" onClick={() => void loadAll()}>Retry</button></div>;

  return (
    <div>
      <AgentActivityBar inFlight={liveJobs} failures={liveFailures} />
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
      {actionError && <p role="alert" className="mb-4 text-sm text-destructive">{actionError}</p>}
      {savedNotice && <p role="status" className="mb-4 text-sm text-brand-strong">{savedNotice}</p>}

      {displayTemplates.length === 0 ? (
        <EmptyState label="No template or record defined for this domain" />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {displayTemplates.map((t) => {
            const record = byKey.get(t.item_key);
            const review = record && reviews.find((item) => item.record_id === record.id);
            const isReference = t.item_type === "reference";
            return (
              <CollapsiblePanel
                key={`${clientId}:${domain}:${t.item_key}`}
                title={t.title}
                badge={t.item_type !== "section" && (
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                      t.item_type === "question"
                        ? "bg-primary/10 text-brand-strong"
                        : "bg-secondary text-secondary-foreground",
                    )}
                  >
                    {isReference ? "Reference" : t.item_type}
                  </span>
                )}
              >
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

                {record?.body && (
                  <div className="mb-3 text-xs text-muted-foreground">
                    <p className={review?.review_state === "supported" ? "text-brand-strong" : "text-destructive"}>
                      Source review: {review?.review_state ?? "missing"}
                    </p>
                    {record.job_id && <p>Model run: {record.job_id}</p>}
                    {review?.source_ref && <p>Source: {review.source_ref}{review.observed_on ? ` · observed ${review.observed_on}` : ""}</p>}
                    {review?.review_note && <p>Review note: {review.review_note}</p>}
                  </div>
                )}

                <div className="mt-auto flex items-center justify-between gap-2 pt-3">
                  <span className="text-xs text-muted-foreground">
                    {record?.edited_at
                      ? "Edited"
                      : isReference
                        ? record?.body
                          ? "Saved"
                          : "Not saved"
                        : record?.body
                          ? "Generated"
                          : "Not generated"}
                  </span>
                  <div className="flex items-center gap-3">
                  {record?.body && <button type="button" onClick={() => { setSavedNotice(null); setReviewing(record); }}
                    className="rounded text-xs font-medium text-brand-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    Review source
                  </button>}
                  {record && clientId && <ArchiveAction clientId={clientId}
                    table="client_agent_records" id={record.id} archived={false}
                    noun="model section" onDone={() => { setActionError(null); void loadRecords(); }}
                    onError={setActionError} />}
                  <button
                    type="button"
                    onClick={() => {
                      setSavedNotice(null);
                      setEditing({
                        itemKey: t.item_key,
                        title: t.title,
                        body: record?.body ?? "",
                        recordId: record?.id ?? null,
                        updatedAt: record?.updated_at ?? null,
                      });
                    }}
                    className="flex items-center gap-1.5 rounded text-xs font-medium text-brand-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    Edit
                  </button>
                  </div>
                </div>
              </CollapsiblePanel>
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
        open={reviewing !== null}
        onClose={() => setReviewing(null)}
        title={reviewing ? `Review source for ${reviewing.title}` : "Review source"}
        intro="Check the exact section against its source. Editing or rerunning the section makes this review stale."
        fields={[
          { name: "source_ref", label: "Source name or URL", kind: "text", required: true },
          { name: "observed_on", label: "Source observation date", kind: "date", required: true },
          { name: "confidence", label: "Factual confidence", kind: "select", required: true,
            options: [
              { value: "supported", label: "Supported by the source" },
              { value: "uncertain", label: "Needs verification" },
              { value: "unsupported", label: "Unsupported or false" },
            ] },
          { name: "review_note", label: "Correction or review note", kind: "textarea", rows: 4 },
        ]}
        initialValues={{
          source_ref: reviewingState?.source_ref ?? "",
          observed_on: reviewingState?.observed_on ?? "",
          // A changed section needs a fresh confidence decision. Never carry
          // its previous "supported" decision into a stale review form.
          confidence: reviewingState?.review_state === "stale"
            ? "" : reviewingState?.confidence ?? "",
          review_note: reviewingState?.review_note ?? "",
        }}
        onSubmit={async (values) => {
          if (!reviewing) throw new Error("Choose a section to review.");
          const { error } = await supabase.rpc("review_model_section_v7", {
            p_record_id: reviewing.id,
            p_source_ref: String(values.source_ref),
            p_observed_on: String(values.observed_on),
            p_confidence: String(values.confidence),
            p_review_note: String(values.review_note ?? ""),
          });
          if (error) throw error;
        }}
        onSaved={() => {
          setSavedNotice(`Source review saved for ${reviewing?.title ?? "section"}.`);
          void loadReviews().catch((error: unknown) => setActionError(
            `The source review saved, but the refreshed state could not be loaded: ${error instanceof Error ? error.message : String(error)}`));
        }}
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
          if (editing.recordId && editing.updatedAt) {
            const { data, error } = await supabase
              .from("client_agent_records")
              .update({ body })
              .eq("id", editing.recordId)
              .eq("client_id", clientId)
              .eq("updated_at", editing.updatedAt)
              .is("archived_at", null)
              .select("id").maybeSingle();
            if (error) throw error;
            if (!data) throw new Error("This section changed while you were editing. Copy your correction, reopen the section and review the latest version.");
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
          }).select("id").single();
          if (error) throw error;
        }}
        onSaved={() => {
          setSavedNotice(`${editing?.title ?? "Section"} saved. Review its source before downstream use.`);
          void Promise.all([loadRecords(), loadReviews()]).catch((error: unknown) => setActionError(
            `The section saved, but the refreshed state could not be loaded: ${error instanceof Error ? error.message : String(error)}`));
        }}
      />
    </div>
  );
}
