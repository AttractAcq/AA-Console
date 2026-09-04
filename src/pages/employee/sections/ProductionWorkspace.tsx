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
  clients: { name: string } | null;
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
        .select("id, title, due_date, compensation, completed_at, client_id, clients(name)")
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
    setSubmissions((delivered.data ?? []) as Submission[]);
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
      title: file.name,
    });
    setUploading(false);
    if (rowError) {
      setError(rowError.message);
      return;
    }
    if (fileRef.current) fileRef.current.value = "";
    setNotice("Delivered. It is now waiting for approval.");
    void refresh();
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading your work…</p>;

  const openJobs = jobs.filter((j) => !j.completed_at);

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
            s.review_status,
          ])}
        />
      </Panel>
    </div>
  );
}
