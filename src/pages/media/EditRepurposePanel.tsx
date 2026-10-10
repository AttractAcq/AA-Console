import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { ContentJourney } from "../../components/ContentJourney";
import { signPaths } from "../../lib/media";
import { supabase } from "../../lib/supabase";

type Source = {
  id: string;
  title: string | null;
  brief_id: string | null;
  storage_path: string;
  edit_stage: string;
  intake_source: string | null;
  usage_rights: string | null;
  intake_notes: string | null;
  created_at: string;
};
type Editor = { id: string; name: string };
type VideoBrief = { id: string; title: string; content_format: string | null };
type Assignment = { id: string; source_asset_id: string | null; stage: string; team_members: { name: string } | null };

/** Human footage lands here after Create, before a finished version can enter Approval. */
export function EditRepurposePanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [params] = useSearchParams();
  const focusedBrief = params.get("brief");
  const [sources, setSources] = useState<Source[]>([]);
  const [editors, setEditors] = useState<Editor[]>([]);
  const [briefs, setBriefs] = useState<VideoBrief[]>([]);
  const [intakeFile, setIntakeFile] = useState<File | null>(null);
  const [intakeTitle, setIntakeTitle] = useState("");
  const [intakeFormat, setIntakeFormat] = useState<"single" | "story" | "reel">("reel");
  const [intakeSource, setIntakeSource] = useState("");
  const [intakeRights, setIntakeRights] = useState("");
  const [intakeBrief, setIntakeBrief] = useState("");
  const [intakeNotes, setIntakeNotes] = useState("");
  const [uploading, setUploading] = useState(false);
  const [assignments, setAssignments] = useState<ReadonlyMap<string, Assignment>>(new Map());
  const [emailStatus, setEmailStatus] = useState<ReadonlyMap<string, string>>(new Map());
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map());
  const [selected, setSelected] = useState<ReadonlyMap<string, string>>(new Map());
  const [dueDates, setDueDates] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    setError(null);
    try {
      const [sourceResult, editorResult, briefResult] = await Promise.all([
        supabase.from("client_media_assets")
          .select("id, title, brief_id, storage_path, edit_stage, intake_source, usage_rights, intake_notes, created_at")
          .eq("client_id", clientId).eq("media_type", "video")
          .in("edit_stage", ["needs_edit", "editing"])
          .order("created_at", { ascending: false }),
        supabase.from("team_members")
          .select("id, name").eq("category", "editors").eq("active", true).order("name"),
        supabase.from("client_briefs").select("id, title, content_format")
          .eq("client_id", clientId).eq("media_type", "video")
          .is("archived_at", null).order("created_at", { ascending: false }),
      ]);
      if (sourceResult.error) throw sourceResult.error;
      if (editorResult.error) throw editorResult.error;
      if (briefResult.error) throw briefResult.error;
      const rows = (sourceResult.data ?? []) as Source[];
      const ids = rows.map((row) => row.id);
      const [assigned, dispatches] = ids.length ? await Promise.all([
        supabase.from("job_assignments")
          .select("id, source_asset_id, stage, team_members(name)")
          .in("source_asset_id", ids).order("created_at", { ascending: false }),
        supabase.from("brief_dispatches")
          .select("assignment_id, source_asset_id, email_status")
          .in("source_asset_id", ids).order("created_at", { ascending: false }),
      ]) : [{ data: [], error: null }, { data: [], error: null }];
      if (assigned.error) throw assigned.error;
      if (dispatches.error) throw dispatches.error;
      const bySource = new Map<string, Assignment>();
      for (const row of (assigned.data ?? []) as unknown as Assignment[]) {
        if (row.source_asset_id && !bySource.has(row.source_asset_id)) bySource.set(row.source_asset_id, row);
      }
      setSources(rows);
      setEditors((editorResult.data ?? []) as Editor[]);
      setBriefs((briefResult.data ?? []) as VideoBrief[]);
      setAssignments(bySource);
      const byAssignmentEmail = new Map<string, string>();
      for (const dispatch of dispatches.data ?? []) {
        if (dispatch.assignment_id) {
          byAssignmentEmail.set(dispatch.assignment_id, dispatch.email_status);
        }
      }
      setEmailStatus(byAssignmentEmail);
      setUrls(await signPaths("client-media", rows.map((row) => row.storage_path)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load video editing work.");
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function assign(source: Source) {
    const editorId = selected.get(source.id);
    if (!editorId) { setError("Choose an editor first."); return; }
    setBusy(source.id);
    setError(null);
    setNotice(null);
    const { error: requestError } = await supabase.rpc("request_human_video_edit", {
      p_asset_id: source.id, p_member_id: editorId,
      ...(dueDates.get(source.id) ? { p_due_date: dueDates.get(source.id) } : {}),
    });
    setBusy(null);
    if (requestError) { setError(requestError.message); return; }
    setNotice("Assigned to the editor dashboard. Email is sent when Resend is configured.");
    void refresh();
  }

  async function finish(source: Source) {
    setBusy(source.id);
    setError(null);
    setNotice(null);
    const { error: finishError } = await supabase.rpc("accept_video_as_finished", { p_asset_id: source.id });
    setBusy(null);
    if (finishError) { setError(finishError.message); return; }
    setNotice("This cut is ready for owner and SMM review.");
    void refresh();
  }

  function chooseFile(file: File | null) {
    if (!file) return;
    setIntakeFile(file);
    if (!intakeTitle) setIntakeTitle(file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "));
  }

  async function uploadSource() {
    if (!clientId || !intakeFile) return;
    if (!intakeFile.type.startsWith("video/") || intakeFile.size > 500 * 1024 * 1024) {
      setError("Choose a video file under 500 MB."); return;
    }
    if (!intakeTitle.trim() || !intakeSource || !intakeRights) {
      setError("Add a title, source and cleared usage rights before uploading."); return;
    }
    const ext = intakeFile.name.split(".").pop()?.toLowerCase();
    if (!ext || !["mp4", "mov", "m4v", "webm"].includes(ext)) {
      setError("Use an MP4, MOV, M4V or WebM video."); return;
    }
    const assetId = crypto.randomUUID();
    const path = `${clientId}/${assetId}.${ext}`;
    setUploading(true);
    setError(null);
    setNotice(null);
    const { error: uploadError } = await supabase.storage.from("client-media")
      .upload(path, intakeFile, { upsert: false });
    if (uploadError) {
      setUploading(false); setError(uploadError.message); return;
    }
    const { error: intakeError } = await supabase.rpc("intake_video_for_edit", {
      p_asset_id: assetId, p_client_id: clientId, p_title: intakeTitle.trim(),
      p_storage_path: path, p_format: intakeFormat, p_source: intakeSource,
      p_rights: intakeRights, p_brief_id: intakeBrief || undefined,
      p_notes: intakeNotes.trim() || undefined,
    });
    if (intakeError) {
      const { error: cleanupError } = await supabase.storage.from("client-media").remove([path]);
      setUploading(false);
      setError(`${intakeError.message}${cleanupError ? ` The uploaded file could not be removed: ${cleanupError.message}` : ""}`);
      return;
    }
    setUploading(false);
    setNotice("Video added to Edit / Repurpose. Choose AI or a human edit when ready.");
    setIntakeFile(null); setIntakeTitle(""); setIntakeNotes(""); setIntakeBrief("");
    void refresh();
  }

  const shown = focusedBrief ? sources.filter((source) => source.brief_id === focusedBrief) : sources;
  return <div>
    <ContentJourney clientId={clientId} current="edit" briefId={focusedBrief} humanVideo />
    <section className="mb-6 space-y-3 rounded-lg border border-border p-4" aria-label="Add video for editing">
      <h2 className="text-sm font-semibold">Add a video for editing</h2>
      <p className="text-xs text-muted-foreground">Upload supplied footage or an existing cut. The original is preserved.</p>
      <div onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => { event.preventDefault(); chooseFile(event.dataTransfer.files[0] ?? null); }}
        className="rounded-md border border-dashed border-border p-4 text-sm">
        <label className="cursor-pointer font-medium text-brand-strong">
          Choose video or drop it here
          <input type="file" accept="video/mp4,video/quicktime,video/x-m4v,video/webm" className="sr-only"
            onChange={(event) => chooseFile(event.target.files?.[0] ?? null)} />
        </label>
        {intakeFile && <p className="mt-2 text-xs text-muted-foreground">{intakeFile.name} · {(intakeFile.size / 1024 / 1024).toFixed(1)} MB</p>}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <input aria-label="Video title" placeholder="Video title" value={intakeTitle}
          onChange={(event) => setIntakeTitle(event.target.value)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm" />
        <select aria-label="Video format" value={intakeFormat} onChange={(event) => {
          setIntakeFormat(event.target.value as "single" | "story" | "reel"); setIntakeBrief("");
        }} className="rounded-md border border-input bg-background px-3 py-2 text-sm">
          <option value="reel">Reel</option><option value="story">Story</option><option value="single">Single video</option>
        </select>
        <select aria-label="Video source" value={intakeSource} onChange={(event) => setIntakeSource(event.target.value)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm">
          <option value="">Where did it come from?</option>
          <option value="client_supplied">Client supplied</option><option value="agency_supplied">Agency supplied</option>
        </select>
        <select aria-label="Usage rights" value={intakeRights} onChange={(event) => setIntakeRights(event.target.value)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm">
          <option value="">Confirm usage rights</option>
          <option value="client_owned">Client owns it</option><option value="licensed">Licensed for use</option>
          <option value="agency_owned">Agency owns it</option>
        </select>
        <select aria-label="Related brief" value={intakeBrief} onChange={(event) => setIntakeBrief(event.target.value)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm sm:col-span-2">
          <option value="">Standalone video (create a brief)</option>
          {briefs.filter((brief) => brief.content_format === intakeFormat).map((brief) =>
            <option key={brief.id} value={brief.id}>{brief.title}</option>)}
        </select>
        <textarea aria-label="Editing notes" placeholder="What should the editor know?" value={intakeNotes}
          onChange={(event) => setIntakeNotes(event.target.value)} rows={3}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm sm:col-span-2" />
      </div>
      <button type="button" disabled={uploading || !intakeFile} onClick={() => void uploadSource()}
        className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
        {uploading ? "Uploading…" : "Add to Edit / Repurpose"}
      </button>
    </section>
    <p className="mb-4 text-sm text-muted-foreground">
      Review human footage, then choose an editor or send the existing cut to approval.
      An edited version keeps the source available for comparison.
    </p>
    {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="mb-3 text-sm text-brand-strong">{notice}</p>}
    {loading ? <p className="text-sm text-muted-foreground">Loading video editing work…</p>
      : shown.length === 0 ? <p className="text-sm text-muted-foreground">No footage waiting for an edit.</p>
        : <div className="space-y-4">{shown.map((source) => {
          const assignment = assignments.get(source.id);
          const active = assignment && ["assigned", "accepted", "rework", "delivered"].includes(assignment.stage);
          return <article key={source.id} className="space-y-3 rounded-lg border border-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">{source.title ?? "Video footage"}</h2>
              <span className="text-xs capitalize text-muted-foreground">{source.edit_stage.replace(/_/g, " ")}</span>
            </div>
            {(source.intake_source || source.usage_rights) && <p className="text-xs text-muted-foreground">
              {source.intake_source?.replace(/_/g, " ") ?? "Source unspecified"}
              {source.usage_rights ? ` · Rights: ${source.usage_rights.replace(/_/g, " ")}` : ""}
            </p>}
            {source.intake_notes && <p className="whitespace-pre-wrap text-xs text-muted-foreground">
              Editing notes: {source.intake_notes}
            </p>}
            {urls.get(source.storage_path)
              ? <video controls preload="metadata" className="w-full max-w-xl rounded-md"
                  src={urls.get(source.storage_path)} aria-label={`Source footage for ${source.title ?? "video"}`} />
              : <p role="alert" className="text-xs text-destructive">Source preview unavailable. Retry before assigning an edit.</p>}
            {active ? <p className="text-xs text-muted-foreground">
              {assignment.team_members?.name ?? "Editor"}: {assignment.stage.replace(/_/g, " ")}
              {emailStatus.get(assignment.id) === "skipped" ? " · assigned, email not sent" : ""}
              {emailStatus.get(assignment.id) === "failed" ? " · email failed" : ""}
              {emailStatus.get(assignment.id) === "sent" ? " · email sent" : ""}
            </p> : <div className="flex flex-wrap items-center gap-2">
              <select aria-label={`Editor for ${source.title ?? "video"}`} value={selected.get(source.id) ?? ""}
                onChange={(event) => setSelected(new Map(selected).set(source.id, event.target.value))}
                className="rounded-md border border-input bg-background px-3 py-2 text-sm">
                <option value="">Choose editor…</option>
                {editors.map((editor) => <option key={editor.id} value={editor.id}>{editor.name}</option>)}
              </select>
              <input type="date" aria-label={`Edit due date for ${source.title ?? "video"}`}
                value={dueDates.get(source.id) ?? ""}
                onChange={(event) => setDueDates(new Map(dueDates).set(source.id, event.target.value))}
                className="rounded-md border border-input bg-background px-3 py-2 text-sm" />
              <button type="button" disabled={busy === source.id || !urls.get(source.storage_path)}
                onClick={() => void assign(source)}
                className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
                {busy === source.id ? "Assigning…" : "Send to editor"}
              </button>
              <button type="button" disabled={busy === source.id || !urls.get(source.storage_path)}
                onClick={() => void finish(source)}
                className="rounded-md border border-border px-3 py-2 text-sm font-medium disabled:opacity-50">
                Use as finished cut
              </button>
            </div>}
          </article>;
        })}</div>}
    <button type="button" className="mt-4 text-xs font-medium text-brand-strong hover:underline"
      onClick={() => void refresh()}>Refresh editing work</button>
  </div>;
}
