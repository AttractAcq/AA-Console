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
  created_at: string;
};
type Editor = { id: string; name: string };
type Assignment = { id: string; source_asset_id: string | null; stage: string; team_members: { name: string } | null };

/** Human footage lands here after Create, before a finished version can enter Approval. */
export function EditRepurposePanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [params] = useSearchParams();
  const focusedBrief = params.get("brief");
  const [sources, setSources] = useState<Source[]>([]);
  const [editors, setEditors] = useState<Editor[]>([]);
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
      const [sourceResult, editorResult] = await Promise.all([
        supabase.from("client_media_assets")
          .select("id, title, brief_id, storage_path, edit_stage, created_at")
          .eq("client_id", clientId).eq("media_type", "video")
          .in("edit_stage", ["needs_edit", "editing"])
          .order("created_at", { ascending: false }),
        supabase.from("team_members")
          .select("id, name").eq("category", "editors").eq("active", true).order("name"),
      ]);
      if (sourceResult.error) throw sourceResult.error;
      if (editorResult.error) throw editorResult.error;
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

  const shown = focusedBrief ? sources.filter((source) => source.brief_id === focusedBrief) : sources;
  return <div>
    <ContentJourney clientId={clientId} current="edit" briefId={focusedBrief} humanVideo />
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
