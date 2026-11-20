import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";

type Project = { id: string; idea: string; audience: string | null;
  stage: string; stage_error: string | null; ir_version: number;
  source_snapshot: unknown; created_at: string };
type Source = { record_id: string; title: string; domain: string;
  observed_on: string | null; review_state: string };

export function CodeVideoProjectsPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [agentPaused, setAgentPaused] = useState(true);
  const [audioAgentPaused, setAudioAgentPaused] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [activeDraft, setActiveDraft] = useState<string | null>(null);
  const [idea, setIdea] = useState("");
  const [audience, setAudience] = useState("");
  const [note, setNote] = useState("");
  const [tone, setTone] = useState<"calm" | "confident" | "energetic">("confident");
  const [seconds, setSeconds] = useState(120);
  const [aspect, setAspect] = useState<"16:9" | "9:16" | "1:1">("16:9");
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    const [projectResult, sourceResult, agentResult, audioAgentResult] = await Promise.all([
      supabase.from("video_projects")
        .select("id,idea,audience,stage,stage_error,ir_version,source_snapshot,created_at")
        .eq("client_id", clientId).order("created_at", { ascending: false }).limit(30),
      supabase.from("model_section_review_state_v7")
        .select("record_id,title,domain,observed_on,review_state")
        .eq("client_id", clientId).eq("review_state", "supported")
        .order("title").limit(100),
      supabase.from("agents").select("paused").eq("agent_key", "video_script").maybeSingle(),
      supabase.from("agents").select("paused").eq("agent_key", "video_audio").maybeSingle(),
    ]);
    if (projectResult.error || sourceResult.error || agentResult.error
      || audioAgentResult.error) {
      setError(projectResult.error?.message ?? sourceResult.error?.message
        ?? agentResult.error?.message ?? audioAgentResult.error?.message
        ?? "Could not load code-rendered video projects.");
      return;
    }
    setProjects((projectResult.data ?? []) as Project[]);
    setSources((sourceResult.data ?? []) as Source[]);
    setAgentPaused(agentResult.data?.paused !== false);
    setAudioAgentPaused(audioAgentResult.data?.paused !== false);
  }, [clientId]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function createDraft() {
    if (!clientId) return;
    setBusy(true); setError(null); setNotice(null);
    const result = await supabase.rpc("create_video_project_draft_v1", {
      p_client_id: clientId, p_idea: idea.trim(), p_audience: audience.trim(),
      p_tone: tone, p_target_length_sec: seconds, p_aspects: [aspect],
      p_request_key: requestKey,
    });
    setBusy(false);
    if (result.error) { setError(result.error.message); return; }
    const draft = result.data as Project;
    setActiveDraft(draft.id);
    setRequestKey(crypto.randomUUID());
    setNotice("Draft saved. Select reviewed sources before starting the script.");
    void refresh();
  }

  async function startDraft(project: Project) {
    setBusy(true); setError(null); setNotice(null);
    const result = await supabase.rpc("start_video_project_v1", {
      p_project_id: project.id, p_expected_ir_version: project.ir_version,
      p_record_ids: selected, p_operator_note: note.trim() || undefined,
    });
    setBusy(false);
    if (result.error) { setError(result.error.message); return; }
    setActiveDraft(null); setSelected([]); setNote("");
    setNotice("Script queued. It remains subject to source, renderer and human review.");
    void refresh();
  }

  const draft = projects.find((project) => project.id === activeDraft && project.stage === "draft");
  return <section aria-label="Code-rendered video projects" className="space-y-4 rounded-lg border border-border p-4">
    <div><h2 className="text-sm font-semibold">Code-rendered video projects</h2>
      <p className="text-xs text-muted-foreground">Save a draft, choose reviewed business sources, then start a sourced storyboard. Rendering and publication require later review.</p></div>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-xs sm:col-span-2">Video idea
        <textarea aria-label="Video idea" value={idea} onChange={(event) => setIdea(event.target.value)}
          maxLength={4000} rows={3} className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" /></label>
      <label className="text-xs">Audience
        <input aria-label="Video audience" value={audience} onChange={(event) => setAudience(event.target.value)}
          maxLength={200} className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" /></label>
      <label className="text-xs">Tone
        <select aria-label="Video tone" value={tone} onChange={(event) => setTone(event.target.value as typeof tone)}
          className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
          <option value="calm">Calm</option><option value="confident">Confident</option><option value="energetic">Energetic</option>
        </select></label>
      <label className="text-xs">Length in seconds
        <input aria-label="Video length" type="number" min={30} max={900} value={seconds}
          onChange={(event) => setSeconds(Number(event.target.value))}
          className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" /></label>
      <label className="text-xs">Aspect
        <select aria-label="Video aspect" value={aspect} onChange={(event) => setAspect(event.target.value as typeof aspect)}
          className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
          <option value="16:9">16:9</option><option value="9:16">9:16</option><option value="1:1">1:1</option>
        </select></label>
    </div>
    <button type="button" disabled={busy || idea.trim().length < 15 || !audience.trim()
      || seconds < 30 || seconds > 900 || !Number.isInteger(seconds)}
      onClick={() => void createDraft()}
      className="rounded-md border border-border px-3 py-2 text-xs font-medium disabled:opacity-50">Save code-video draft</button>
    {draft && <div className="space-y-3 rounded-md border border-border p-3">
      <h3 className="text-xs font-semibold">Sources for this draft</h3>
      <p className="text-xs text-muted-foreground">Only current, supported model sections appear. An operator note is identified separately. Source selection does not approve factual claims.</p>
      <div className="max-h-44 space-y-1 overflow-y-auto">
        {sources.map((source) => <label key={source.record_id} className="flex gap-2 text-xs">
          <input type="checkbox" checked={selected.includes(source.record_id)}
            disabled={!selected.includes(source.record_id) && selected.length >= 12}
            onChange={() => setSelected((current) => current.includes(source.record_id)
              ? current.filter((id) => id !== source.record_id) : [...current, source.record_id])} />
          <span>{source.title} · {source.domain} · {source.observed_on ?? "date unknown"}</span>
        </label>)}
        {sources.length === 0 && <p className="text-xs text-muted-foreground">No reviewed model sources available.</p>}
      </div>
      <label className="block text-xs">Operator note
        <textarea aria-label="Video operator note" value={note} onChange={(event) => setNote(event.target.value)}
          maxLength={4000} rows={2} className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" /></label>
      <button type="button" disabled={busy || agentPaused} onClick={() => void startDraft(draft)}
        className="rounded-md border border-border px-3 py-2 text-xs font-medium disabled:opacity-50">Start storyboard</button>
      {agentPaused && <p className="text-xs text-muted-foreground">The video script worker is paused for this release.</p>}
    </div>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {notice && <p role="status" className="text-xs text-brand-strong">{notice}</p>}
    <div className="space-y-2"><h3 className="text-xs font-semibold">Recent code-video projects</h3>
      {projects.length === 0 && <p className="text-xs text-muted-foreground">No code-rendered projects yet.</p>}
      {projects.map((project) => <div key={project.id} className="flex items-start justify-between gap-3 border-t border-border pt-2 text-xs">
        <div><p className="font-medium">{project.idea}</p>
          <p className="text-muted-foreground">{project.stage}{project.stage_error ? ` · ${project.stage_error}` : ""}
            {project.stage === "timing" && audioAgentPaused ? " · Audio worker paused" : ""}</p></div>
        {project.stage === "draft" && <button type="button" onClick={() => { setActiveDraft(project.id); setSelected([]); setNote(""); }}
          className="shrink-0 text-brand-strong hover:underline">Choose sources</button>}
      </div>)}
    </div>
  </section>;
}
