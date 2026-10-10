import { useCallback, useEffect, useRef, useState } from "react";
import { Clapperboard, Scissors, Upload } from "lucide-react";
import { Panel } from "../../../components/Panel";
import { DataTable } from "../../../components/DataTable";
import { EmptyState } from "../../../components/EmptyState";
import { Modal } from "../../../components/Modal";
import { supabase } from "../../../lib/supabase";
import { signPaths } from "../../../lib/media";

type Job = {
  id: string;
  title: string;
  due_date: string | null;
  compensation: number | null;
  completed_at: string | null;
  /**
   * Where this piece of work has got to. Seven states, not two: delivered
   * and approved are deliberately different, so a file uploaded and waiting
   * on a reviewer is not shown as finished.
   */
  stage: string;
  stage_reason: string | null;
  client_id: string | null;
  // The brief this job exists to satisfy. Carried onto the delivered asset —
  // without it a human-made asset has no route back to its brief or its idea,
  // and falls out of attribution entirely. That was the case for every asset
  // an editor or avatar had ever delivered.
  brief_id: string | null;
  source_asset_id: string | null;
  clients: { name: string } | null;
  client_briefs: { title: string; brief_ref: string | null; body: string | null; content_format?: string | null; avatar_brief?: string | null; editor_brief?: string | null } | null;
  brief_role?: string | null;
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

/** Stages where the maker still owes something. */
const OWED = new Set(["assigned", "accepted", "rework"]);

/**
 * What each stage says to the person it belongs to. Said in their terms:
 * "delivered" is the agency's word for it, and what the maker needs to know
 * is that it is no longer theirs to do.
 */
const STAGE_LABEL: Record<string, string> = {
  assigned: "New",
  accepted: "Accepted",
  declined: "Declined",
  delivered: "With the reviewer",
  rework: "Needs another version",
  approved: "Done",
  cancelled: "Withdrawn",
};

const STAGE_TONE: Record<string, string> = {
  rework: "bg-destructive/10 text-destructive",
  declined: "bg-muted text-muted-foreground",
  cancelled: "bg-muted text-muted-foreground",
  approved: "bg-primary/10 text-brand-strong",
};

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
  const [sourceUrls, setSourceUrls] = useState<ReadonlyMap<string, string>>(new Map());
  const [sourceNotes, setSourceNotes] = useState<ReadonlyMap<string, string>>(new Map());
  const [rejectionReasons, setRejectionReasons] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [jobId, setJobId] = useState("");
  const [acting, setActing] = useState<string | null>(null);
  // Declining asks why, because decline_assignment refuses an empty reason
  // and the reason is the only thing the agency can act on.
  const [declining, setDeclining] = useState<string | null>(null);
  const [declineReason, setDeclineReason] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const [assigned, delivered] = await Promise.all([
      supabase
        .from("job_assignments")
        .select(
          "id, title, due_date, compensation, completed_at, stage, stage_reason, client_id, brief_id, source_asset_id, clients(name), client_briefs(title, brief_ref, body, content_format, avatar_brief, editor_brief)",
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
    const jobs = (assigned.data ?? []) as unknown as Job[];
    setJobs(jobs);
    const sourceIds = jobs.map((job) => job.source_asset_id).filter((id): id is string => Boolean(id));
    if (sourceIds.length) {
      const { data: sources } = await supabase.from("client_media_assets")
        .select("id, storage_path, intake_notes").in("id", sourceIds);
      const signed = await signPaths("client-media", (sources ?? []).map((source) => source.storage_path));
      setSourceUrls(new Map((sources ?? []).flatMap((source) => {
        const url = signed.get(source.storage_path);
        return url ? [[source.id, url] as const] : [];
      })));
      setSourceNotes(new Map((sources ?? []).flatMap((source) =>
        source.intake_notes ? [[source.id, source.intake_notes] as const] : [])));
    } else { setSourceUrls(new Map()); setSourceNotes(new Map()); }
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
    if (job.source_asset_id && !file.type.startsWith("video/")) {
      setError("Deliver a video file for this edit assignment.");
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
      // The same id as the storage path, set explicitly rather than left to
      // the default: deliver_assignment is handed this id so the assignment
      // and the asset point at each other, and a generated default would
      // leave the path naming one row and the link naming another.
      id: assetId,
      client_id: clientId,
      member_id: memberId,
      media_type: mediaTypeOf(file),
      storage_path: path,
      // The brief, not just the client. This is the link the whole chain hangs
      // on: asset -> brief -> idea, and later performance -> idea.
      brief_id: job.brief_id,
      source_asset_id: job.source_asset_id,
      content_format: job.client_briefs?.content_format === "reel" ? "reel" : "single",
      // Named after the work, not after whatever the camera called the file.
      // "IMG_4032.mov" tells a reviewer nothing about what they are approving.
      title: job.client_briefs?.title ?? job.title ?? file.name,
    });
    if (rowError) {
      setUploading(false);
      setError(rowError.message);
      return;
    }

    // Mark it delivered — not done. This used to write completed_at
    // directly, which closed the job the instant a file arrived while the
    // asset was still unreviewed, and left a later rejection with nowhere
    // to go. deliver_assignment moves it to 'delivered'; approving the
    // asset is what finishes it, and rejecting it sends this back as
    // rework with the reviewer's own words.
    const { error: closeError } = await supabase.rpc("deliver_assignment", {
      p_assignment_id: job.id,
      p_asset_id: assetId,
    });

    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
    setJobId("");
    // The file is delivered either way; a failure to record it is worth
    // saying rather than swallowing, but it is not a failed delivery.
    setNotice(
      closeError
        ? "Delivered and waiting for approval — but the job could not be marked delivered. Tell the agency."
        : job.source_asset_id
          ? "Edited version delivered. It is now waiting for approval; the original footage remains on file."
          : variant === "avatars" && file.type.startsWith("video/")
            ? "Footage delivered to Edit / Repurpose. Approval follows the finished edit."
          : "Delivered. It is now waiting for approval.",
    );
    void refresh();
  }

  /**
   * Accept or decline. Through the named functions rather than an update:
   * job_assignments.stage is written only by advance_assignment, and a
   * direct write is refused by trigger.
   */
  async function act(id: string, what: "accept" | "decline", reason?: string) {
    setActing(id);
    setError(null);
    setNotice(null);
    const { error: failure } = await supabase.rpc(
      what === "accept" ? "accept_assignment" : "decline_assignment",
      what === "accept" ? { p_assignment_id: id } : { p_assignment_id: id, p_reason: reason },
    );
    setActing(null);
    if (failure) {
      setError(failure.message);
      return;
    }
    setNotice(what === "accept" ? "Accepted." : "Declined. The agency will reassign it.");
    void refresh();
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading your work…</p>;

  // Outstanding means the maker still owes something. Delivered work is
  // waiting on a reviewer rather than on them, and rework is owed again —
  // which is the state that did not exist before and so could not be shown.
  const openJobs = jobs.filter((j) => OWED.has(j.stage));
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
                  {/* What the reviewer actually said. Before this there was
                      nowhere for it to go: the assignment was already
                      closed when the rejection arrived. */}
                  {job.stage === "rework" && job.stage_reason && (
                    <p className="mt-1 text-xs text-destructive">{job.stage_reason}</p>
                  )}
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                    STAGE_TONE[job.stage] ?? "bg-secondary text-secondary-foreground"
                  }`}
                >
                  {STAGE_LABEL[job.stage] ?? job.stage}
                </span>
                {job.stage === "assigned" && (
                  <span className="flex shrink-0 gap-1.5">
                    <button
                      type="button"
                      disabled={acting === job.id}
                      onClick={() => void act(job.id, "accept")}
                      className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      disabled={acting === job.id}
                      onClick={() => setDeclining(job.id)}
                      className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-destructive disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Decline
                    </button>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Modal
        open={declining !== null}
        onClose={() => setDeclining(null)}
        title="Decline this job"
      >
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Say why. The agency reassigns it from this, so a decline with no reason leaves them
            guessing — and it is refused without one.
          </p>
          <label htmlFor="decline-reason" className="sr-only">
            Why you are declining
          </label>
          <textarea
            id="decline-reason"
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-input bg-background p-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDeclining(null)}
              className="rounded-md px-3.5 py-2 text-sm font-medium text-muted-foreground hover:bg-accent"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!declineReason.trim()}
              onClick={() => {
                const id = declining;
                setDeclining(null);
                if (id) void act(id, "decline", declineReason.trim());
                setDeclineReason("");
              }}
              className="rounded-md bg-destructive px-3.5 py-2 text-sm font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Decline
            </button>
          </div>
        </div>
      </Modal>

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
                {(() => {
                  const cb = selected.client_briefs as {
                    body: string | null;
                    avatar_brief?: string | null;
                    editor_brief?: string | null;
                  };
                  // Prefer role body when the assignment was a dual-brief send.
                  // Fall back to master body for legacy / full dispatches.
                  const role = (selected as { brief_role?: string }).brief_role;
                  if (role === "avatar" && cb.avatar_brief) return cb.avatar_brief;
                  if ((role === "editor" || selected.source_asset_id) && cb.editor_brief) return cb.editor_brief;
                  return cb.body ?? "This brief has no detail beyond its title.";
                })()}
              </p>
            </details>
          )}
          {selected?.source_asset_id && (sourceUrls.get(selected.source_asset_id)
            ? <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Source footage to edit</p>
                {sourceNotes.get(selected.source_asset_id) && <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                  Source-specific instructions: {sourceNotes.get(selected.source_asset_id)}
                </p>}
                <video controls preload="metadata" className="w-full max-w-xl rounded-md"
                  src={sourceUrls.get(selected.source_asset_id)} />
              </div>
            : <p role="alert" className="text-xs text-destructive">Source footage preview unavailable. Ask the agency before delivering an edit.</p>)}
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
            disabled={uploading || Boolean(selected?.source_asset_id && !sourceUrls.get(selected.source_asset_id))}
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
