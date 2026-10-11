import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { signPaths } from "../../lib/media";
import { supabase } from "../../lib/supabase";

type Preset = "explainer" | "tutorial" | "hero";
type Aspect = "vertical" | "square" | "horizontal";
type Project = { id: string; prompt: string; preset: Preset; aspect: Aspect;
  duration_sec: number; brand_mode: "on_brand" | "neutral"; status: string;
  scene_plan: unknown; render_path: string | null; poster_path: string | null;
  error: string | null; revision_of: string | null; created_at: string };
type Brief = { id: string; title: string };
type Attachment = { project_id: string; asset_id: string; brief_id: string | null };

/** Independent prompt-to-motion page; output can later be attached to content or sites. */
export function MotionDesignPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [prompt, setPrompt] = useState("");
  const [preset, setPreset] = useState<Preset>("explainer");
  const [aspect, setAspect] = useState<Aspect>("horizontal");
  const [duration, setDuration] = useState(8);
  const [brandMode, setBrandMode] = useState<"on_brand" | "neutral">("on_brand");
  const [revisionOf, setRevisionOf] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachSelections, setAttachSelections] = useState<Record<string, string>>({});
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    try {
      const [result, briefResult] = await Promise.all([
        supabase.from("motion_design_projects")
          .select("id, prompt, preset, aspect, duration_sec, brand_mode, status, scene_plan, render_path, poster_path, error, revision_of, created_at")
          .eq("client_id", clientId).order("created_at", { ascending: false }).limit(30),
        supabase.from("client_briefs").select("id, title")
          .eq("client_id", clientId).eq("media_type", "video").eq("status", "approved")
          .order("created_at", { ascending: false }).limit(30),
      ]);
      if (result.error) throw result.error;
      if (briefResult.error) throw briefResult.error;
      const rows = (result.data ?? []) as Project[];
      const ids = rows.map((project) => project.id);
      const attachmentResult = ids.length ? await supabase.from("motion_design_attachments")
        .select("project_id, asset_id, brief_id").in("project_id", ids)
        : { data: [], error: null };
      if (attachmentResult.error) throw attachmentResult.error;
      setProjects(rows);
      setBriefs((briefResult.data ?? []) as Brief[]);
      setAttachments((attachmentResult.data ?? []) as Attachment[]);
      setUrls(await signPaths("client-media", rows.flatMap((project) =>
        [project.render_path, project.poster_path].filter((path): path is string => !!path))));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load motion projects.");
    } finally { setLoading(false); }
  }, [clientId]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function generate() {
    if (!clientId) return;
    if (prompt.trim().length < 15) { setError("Describe the video in at least 15 characters."); return; }
    setBusy(true); setError(null); setNotice(null);
    const result = await supabase.rpc("request_motion_design", {
      p_client_id: clientId, p_prompt: prompt.trim(), p_preset: preset, p_aspect: aspect,
      p_duration_sec: duration, p_brand_mode: brandMode, p_revision_of: revisionOf,
    });
    setBusy(false);
    if (result.error) { setError(result.error.message); return; }
    setRevisionOf(null);
    setNotice("Motion design queued. Refresh to see the render.");
    void refresh();
  }

  function revise(project: Project) {
    setPrompt(project.prompt);
    setPreset(project.preset);
    setAspect(project.aspect);
    setDuration(project.duration_sec);
    setBrandMode(project.brand_mode);
    setRevisionOf(project.id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function download(project: Project) {
    const url = project.render_path ? urls.get(project.render_path) : null;
    if (!url) return;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Download returned HTTP ${response.status}.`);
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl; link.download = `motion-${project.id}.mp4`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not export the video.");
    }
  }

  async function attach(project: Project) {
    const briefId = attachSelections[project.id] || null;
    setBusy(true); setError(null); setNotice(null);
    const result = await supabase.rpc("attach_motion_design", {
      p_project_id: project.id, p_brief_id: briefId,
    });
    setBusy(false);
    if (result.error) { setError(result.error.message); return; }
    setNotice("Motion video attached as a pending asset. Owner and SMM review are still required.");
    void refresh();
  }

  return <div className="space-y-6">
    <section className="space-y-3 rounded-lg border border-border p-4" aria-label="Create motion design">
      <h2 className="text-sm font-semibold">Create motion design</h2>
      <p className="text-xs text-muted-foreground">Describe a short motion graphic. Claude plans bounded typography and abstract shapes; the renderer returns a muted MP4 and poster. Explainers, tutorials, and looping heroes use one workflow.</p>
      {revisionOf && <p className="text-xs text-brand-strong">Revising an earlier design. The previous MP4 stays in project history.</p>}
      <label className="block text-xs font-medium">Prompt
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={4000} rows={5}
          placeholder="Show how our service turns a rough idea into a ready-to-publish campaign, with three clear steps and a calm visual rhythm."
          className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" /></label>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-xs">Use
          <select aria-label="Motion use" value={preset} onChange={(event) => {
            const next = event.target.value as Preset; setPreset(next);
            if (next === "hero") { setAspect("horizontal"); setDuration(Math.min(duration, 12)); }
          }} className="mt-1 w-full rounded-md border border-input bg-background px-2 py-2 text-sm">
            <option value="explainer">Explainer</option><option value="tutorial">Tutorial</option>
            <option value="hero">Looping hero</option>
          </select></label>
        <label className="text-xs">Aspect
          <select aria-label="Motion aspect" value={aspect} onChange={(event) => setAspect(event.target.value as Aspect)}
            className="mt-1 w-full rounded-md border border-input bg-background px-2 py-2 text-sm">
            <option value="horizontal">Horizontal</option><option value="vertical">Vertical</option>
            <option value="square">Square</option>
          </select></label>
        <label className="text-xs">Duration · {duration}s
          <input aria-label="Motion duration" type="range" min={4} max={preset === "hero" ? 12 : 20}
            value={duration} onChange={(event) => setDuration(Number(event.target.value))}
            className="mt-3 w-full" /></label>
        <label className="text-xs">Colours
          <select aria-label="Motion brand" value={brandMode}
            onChange={(event) => setBrandMode(event.target.value as "on_brand" | "neutral")}
            className="mt-1 w-full rounded-md border border-input bg-background px-2 py-2 text-sm">
            <option value="on_brand">Client brand</option><option value="neutral">Neutral</option>
          </select></label>
      </div>
      <p className="text-xs text-muted-foreground">Available animation: orbit, bars, cards, rise, slide, and pulse. This version has no voiceover, stock footage, or free-form effects.</p>
      <div className="flex gap-2">
        <button type="button" disabled={busy || prompt.trim().length < 15} onClick={() => void generate()}
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {busy ? "Queuing…" : revisionOf ? "Generate revision" : "Generate video"}
        </button>
        {revisionOf && <button type="button" className="rounded-md border border-border px-3 py-2 text-sm"
          onClick={() => setRevisionOf(null)}>Cancel revision</button>}
      </div>
    </section>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-brand-strong">{notice}</p>}
    <section aria-label="Motion design history" className="space-y-3">
      <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">Projects</h2>
        <button type="button" onClick={() => void refresh()} className="text-xs font-medium text-brand-strong hover:underline">Refresh projects</button></div>
      {loading ? <p className="text-sm text-muted-foreground">Loading motion designs…</p>
        : projects.length === 0 ? <p className="text-sm text-muted-foreground">No motion designs yet.</p>
          : projects.map((project) => <article key={project.id} className="space-y-2 rounded-lg border border-border p-4">
            <div className="flex justify-between gap-2"><h3 className="text-sm font-medium capitalize">{project.preset} · {project.duration_sec}s</h3>
              <span className="text-xs capitalize text-muted-foreground">{project.status}</span></div>
            <p className="whitespace-pre-wrap text-xs text-muted-foreground">{project.prompt}</p>
            {project.revision_of && <p className="text-xs text-muted-foreground">Revision of {project.revision_of.slice(0, 8)}</p>}
            {project.error && <p role="alert" className="text-xs text-destructive">{project.error}</p>}
            {project.render_path && urls.get(project.render_path) && <video controls preload="metadata"
              poster={project.poster_path ? urls.get(project.poster_path) : undefined}
              src={urls.get(project.render_path)} className="w-full max-w-xl rounded-md" />}
            {project.scene_plan != null && <details className="text-xs"><summary className="cursor-pointer">View scene plan</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2">{JSON.stringify(project.scene_plan, null, 2)}</pre></details>}
            {project.status === "completed" && <div className="flex gap-3 text-xs font-medium text-brand-strong">
              <button type="button" onClick={() => revise(project)} className="hover:underline">Revise</button>
              {project.render_path && urls.get(project.render_path) && <button type="button"
                onClick={() => void download(project)} className="hover:underline">Export MP4</button>}
            </div>}
            {project.status === "completed" && <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <select aria-label={`Attach ${project.preset} motion design`} value={attachSelections[project.id] ?? ""}
                onChange={(event) => setAttachSelections({ ...attachSelections, [project.id]: event.target.value })}
                className="rounded-md border border-input bg-background px-2 py-2 text-xs">
                <option value="">Standalone video</option>
                {briefs.map((brief) => <option key={brief.id} value={brief.id}>{brief.title}</option>)}
              </select>
              {attachments.some((item) => item.project_id === project.id
                && item.brief_id === (attachSelections[project.id] || null))
                ? <Link to={`/clients/${clientId}/delivery/approvals?tab=assets`}
                  className="text-xs font-medium text-brand-strong hover:underline">Open approval asset</Link>
                : <button type="button" disabled={busy} onClick={() => void attach(project)}
                  className="rounded-md border border-border px-3 py-2 text-xs font-medium disabled:opacity-50">
                  Send to approvals
                </button>}
            </div>}
          </article>)}
    </section>
  </div>;
}
