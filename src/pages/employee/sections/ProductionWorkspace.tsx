import { useCallback, useEffect, useRef, useState } from "react";
import { Clapperboard, Scissors, Upload } from "lucide-react";
import { Panel } from "../../../components/Panel";
import { DataTable } from "../../../components/DataTable";
import { EmptyState } from "../../../components/EmptyState";
import { supabase } from "../../../lib/supabase";

type Job = {
  id: string;
  title: string;
  due_date: string | null;
  compensation: number | null;
  completed_at: string | null;
  client_id: string | null;
  // The brief this job exists to satisfy. Carried onto the delivered asset —
  // without it a human-made asset has no route back to its brief or its idea,
  // and falls out of attribution entirely. That was the case for every asset
  // an editor or avatar had ever delivered.
  brief_id: string | null;
  clients: { name: string } | null;
  client_briefs: { title: string; brief_ref: string | null; body: string | null } | null;
};

type Submission = {
  id: string;
  title: string | null;
  ref_number: string | null;
  media_type: string;
  review_status: string;
  created_at: string;
};

type Variant = "editors" | "avatars";

const COPY: Record<
  Variant,
  { queue: string; queueEmpty: string; deliver: string; icon: typeof Scissors; accepts: string }
> = {
  editors: {
    queue: "Edit queue",
    queueEmpty: "No edits assigned to you yet",
    deliver: "Deliver an edit",
    icon: Scissors,
    accepts: "video/*,image/*",
  },
  avatars: {
    queue: "Your shoots",
    queueEmpty: "No shoots assigned to you yet",
    deliver: "Upload footage",
    icon: Clapperboard,
    accepts: "video/*,image/*",
  },
};

function mediaTypeOf(file: File): "image" | "video" | "text" {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("image/")) return "image";
  return "text";
}

/** Editors and Avatars both work a job queue and deliver files against it. */
export function ProductionWorkspace({
  memberId,
  variant,
}: {
  memberId: string;
  variant: Variant;
}) {
  const copy = COPY[variant];
  const QueueIcon = copy.icon;

  const [jobs, setJobs] = useState<Job[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [rejectionReasons, setRejectionReasons] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [jobId, setJobId] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const [assigned, delivered] = await Promise.all([
      supabase
        .from("job_assignments")
        .select(
          "id, title, due_date, compensation, completed_at, client_id, brief_id, clients(name), client_briefs(title, brief_ref, body)",
        )
        .eq("member_id", memberId)
        .order("due_date", { nullsFirst: false }),
      supabase
        .from("client_media_assets")
        .select("id, title, ref_number, media_type, review_status, created_at")
        .eq("member_id", memberId)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);
    setJobs((assigned.data ?? []) as unknown as Job[]);
    const rows = (delivered.data ?? []) as Submission[];
    setSubmissions(rows);

    // Only the rejected ones need a reason, and RLS lets the maker read the
    // reviews of assets they made.
    const rejected = rows.filter((r) => r.review_status === "rejected").map((r) => r.id);
    if (rejected.length > 0) {
      const { data: reviews } = await supabase
        .from("client_asset_reviews")
        .select("asset_id, reason, created_at")
        .in("asset_id", rejected)
        .eq("decision", "rejected")
        .order("created_at", { ascending: false });
      const latest = new Map<string, string>();
      for (const review of reviews ?? []) {
        const assetId = review.asset_id as string;
        if (!latest.has(assetId) && review.reason) latest.set(assetId, review.reason as string);
      }
      setRejectionReasons(latest);
    } else {
      setRejectionReasons(new Map());
    }
    setLoading(false);
  }, [memberId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleUpload() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose a file first.");
      return;
    }
    const job = jobs.find((j) => j.id === jobId);
    const clientId = job?.client_id;
    if (!clientId) {
      setError("Pick a job that is attached to a client.");
      return;
    }

    setError(null);
    setNotice(null);
    setUploading(true);

    // Storage RLS is written against the path prefix, so the client id
    // has to be the first segment.
    const assetId = crypto.randomUUID();
    const ext = file.name.split(".").pop() ?? "bin";
    const path = `${clientId}/${assetId}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from("client-media")
      .upload(path, file, { upsert: false });
    if (uploadError) {
      setUploading(false);
      setError(uploadError.message);
      return;
    }

    const { error: rowError } = await supabase.from("client_media_assets").insert({
      client_id: clientId,
      member_id: memberId,
      media_type: mediaTypeOf(file),
      storage_path: path,
      // The brief, not just the client. This is the link the whole chain hangs
      // on: asset -> brief -> idea, and later performance -> idea.
      brief_id: job.brief_id,
      // Named after the work, not after whatever the camera called the file.
      // "IMG_4032.mov" tells a reviewer nothing about what they are approving.
      title: job.client_briefs?.title ?? job.title ?? file.name,
    });
    if (rowError) {
      setUploading(false);
      setError(rowError.message);
      return;
    }

    // Close the assignment. Without this a delivered job stays in the open
    // queue forever, so neither the maker nor the agency can tell what is
    // still outstanding.
    const { error: closeError } = await supabase
      .from("job_assignments")
      .update({ completed_at: new Date().toISOString() })
      .eq("id", job.id);

    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
    setJobId("");
    // The file is delivered either way; a failure to close the job is worth
    // saying rather than swallowing, but it is not a failed delivery.
    setNotice(
      closeError
        ? "Delivered and waiting for approval — but the job could not be marked done. Tell the agency."
        : "Delivered. It is now waiting for approval.",
    );
    void refresh();
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading your work…</p>;

  const openJobs = jobs.filter((j) => !j.completed_at);
  const selected = jobs.find((j) => j.id === jobId);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-5">
          <span className="text-sm text-muted-foreground">Open</span>
          <p className="mt-2 text-2xl font-semibold text-card-foreground">{openJobs.length}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-5">
          <span className="text-sm text-muted-foreground">Delivered</span>
          <p className="mt-2 text-2xl font-semibold text-card-foreground">{submissions.length}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-5">
          <span className="text-sm text-muted-foreground">Awaiting review</span>
          <p className="mt-2 text-2xl font-semibold text-card-foreground">
            {submissions.filter((s) => s.review_status === "pending").length}
          </p>
        </div>
      </div>

      <Panel title={copy.queue}>
        {jobs.length === 0 ? (
          <EmptyState label={copy.queueEmpty} minHeight={100} />
        ) : (
          <div className="space-y-2">
            {jobs.map((job) => (
              <div
                key={job.id}
                className="flex items-center gap-3 rounded-md border border-border p-3.5"
              >
                <QueueIcon
                  className="h-4 w-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{job.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {job.clients?.name ?? "Unassigned client"}
                    {job.due_date ? ` · due ${job.due_date}` : ""}
                  </p>
                </div>
                {job.completed_at && (
                  <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
                    Done
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title={copy.deliver}>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <select
              aria-label="Job"
              value={jobId}
              onChange={(e) => setJobId(e.target.value)}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">Select a job…</option>
              {openJobs.map((job) => (
                <option key={job.id} value={job.id}>
                  {job.title}
                  {job.clients?.name ? ` — ${job.clients.name}` : ""}
                </option>
              ))}
            </select>
            <input
              ref={fileRef}
              type="file"
              aria-label="File"
              accept={copy.accepts}
              className="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground file:mr-3 file:rounded file:border-0 file:bg-secondary file:px-2.5 file:py-1 file:text-xs file:text-secondary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          {/* The brief, on the page where the work is actually delivered.
              It lived on a different page, so a maker had to hold it in their
              head while uploading against it. */}
          {selected?.client_briefs && (
            <details className="rounded-md border border-border p-3">
              <summary className="cursor-pointer text-sm font-medium text-foreground">
                {selected.client_briefs.brief_ref
                  ? `${selected.client_briefs.brief_ref} — `
                  : ""}
                {selected.client_briefs.title}
              </summary>
              <p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap text-sm text-muted-foreground">
                {selected.client_briefs.body ?? "This brief has no detail beyond its title."}
              </p>
            </details>
          )}
          {selected && !selected.brief_id && (
            <p className="text-xs text-muted-foreground">
              This job has no brief attached — deliver against its title.
            </p>
          )}

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {notice && <p className="text-sm text-brand-strong">{notice}</p>}

          <button
            type="button"
            onClick={handleUpload}
            disabled={uploading}
            className="flex items-center gap-2 rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Upload className="h-4 w-4" aria-hidden="true" />
            {uploading ? "Uploading…" : copy.deliver}
          </button>
        </div>
      </Panel>

      <Panel title="Finished work">
        <DataTable
          columns={["Ref", "File", "Type", "Status"]}
          emptyLabel="Nothing delivered yet"
          rows={submissions.map((s) => [
            s.ref_number ?? "—",
            s.title ?? "—",
            s.media_type,
            // A rejection without its reason is a dead end for the person who
            // has to fix it, so the reason travels with the status.
            s.review_status === "rejected" ? (
              <span key="s">
                <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                  rejected
                </span>
                {rejectionReasons.get(s.id) && (
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {rejectionReasons.get(s.id)}
                  </span>
                )}
              </span>
            ) : (
              s.review_status
            ),
          ])}
        />
      </Panel>
    </div>
  );
}
