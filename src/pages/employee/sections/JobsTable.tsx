import { useCallback, useEffect, useState } from "react";
import { DataTable } from "../../../components/DataTable";
import { Modal } from "../../../components/Modal";
import { EmptyState } from "../../../components/EmptyState";
import { supabase } from "../../../lib/supabase";

type Job = {
  id: string;
  title: string;
  due_date: string | null;
  compensation: number | null;
  completed_at: string | null;
  brief_id: string | null;
  clients: { name: string } | null;
  client_briefs: { brief_ref: string | null } | null;
};

type Brief = {
  id: string;
  brief_ref: string | null;
  title: string;
  body: string | null;
  media_type: string;
  status: string;
};

/**
 * Avatars call them jobs, editors call them projects — same
 * job_assignments rows, split on whether they have been completed.
 */
export function JobsTable({
  memberId,
  scope,
  noun,
}: {
  memberId: string;
  scope: "current" | "past";
  noun: "Job" | "Project";
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefLoading, setBriefLoading] = useState(false);

  const refresh = useCallback(async () => {
    let query = supabase
      .from("job_assignments")
      .select(
        "id, title, due_date, compensation, completed_at, brief_id, clients(name), client_briefs(brief_ref)",
      )
      .eq("member_id", memberId);

    query =
      scope === "current"
        ? query.is("completed_at", null).order("due_date", { nullsFirst: false })
        : query.not("completed_at", "is", null).order("completed_at", { ascending: false });

    const { data } = await query;
    setJobs((data ?? []) as unknown as Job[]);
    setLoading(false);
  }, [memberId, scope]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function openBrief(briefId: string) {
    setBrief(null);
    setBriefOpen(true);
    setBriefLoading(true);
    const { data } = await supabase
      .from("client_briefs")
      .select("id, brief_ref, title, body, media_type, status")
      .eq("id", briefId)
      .maybeSingle();
    setBrief((data as Brief) ?? null);
    setBriefLoading(false);
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  const columns =
    scope === "current"
      ? [noun, "Client", "Due Date", "Compensation", "Brief"]
      : [noun, "Client", "Completed", "Compensation", "Brief"];

  const money = (v: number | null) => (v === null ? "—" : Number(v).toFixed(2));

  return (
    <>
      <DataTable
        columns={columns}
        emptyLabel={
          scope === "current"
            ? `No current ${noun.toLowerCase()}s assigned to you`
            : `No completed ${noun.toLowerCase()}s yet`
        }
        rows={jobs.map((job) => [
          job.title,
          job.clients?.name ?? "—",
          scope === "current" ? (job.due_date ?? "—") : (job.completed_at?.slice(0, 10) ?? "—"),
          money(job.compensation),
          job.brief_id ? (
            <button
              key={job.id}
              type="button"
              onClick={() => void openBrief(job.brief_id!)}
              className="rounded text-sm font-medium text-brand-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Brief{job.client_briefs?.brief_ref ? ` · ${job.client_briefs.brief_ref}` : ""}
            </button>
          ) : (
            <span key={job.id} className="text-muted-foreground">
              —
            </span>
          ),
        ])}
      />

      <Modal
        open={briefOpen}
        onClose={() => setBriefOpen(false)}
        title={brief ? `${brief.brief_ref ?? "Brief"} · ${brief.title}` : "Brief"}
      >
        {briefLoading ? (
          <p className="text-sm text-muted-foreground">Loading brief…</p>
        ) : !brief ? (
          <EmptyState label="This brief is no longer available" minHeight={120} />
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium capitalize text-secondary-foreground">
                {brief.media_type}
              </span>
              <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium capitalize text-brand-strong">
                {brief.status.replace(/_/g, " ")}
              </span>
            </div>
            {brief.body ? (
              <p className="whitespace-pre-wrap text-sm text-foreground">{brief.body}</p>
            ) : (
              <EmptyState label="This brief has no content yet" minHeight={120} />
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
