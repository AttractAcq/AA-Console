import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { CodeVideoRenderCandidatesPanel } from "./CodeVideoRenderCandidatesPanel";
import { CodeVideoAttachmentsPanel } from "./CodeVideoAttachmentsPanel";
import { CodeVideoProjectReviewPanel } from "./CodeVideoProjectReviewPanel";

type Project = { id: string; idea: string; audience: string | null;
  stage: string; stage_error: string | null; ir_version: number;
  source_snapshot: unknown; created_at: string };
type Source = { record_id: string; title: string; domain: string;
  observed_on: string | null; review_state: string };
type BriefBinding = { briefId: string; title: string;
  campaignId: string | null; routePackageId: string | null;
  route: string | null; routeVersion: number | null };

export function CodeVideoProjectsPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [params] = useSearchParams();
  const requestedBriefId = params.get("videoBrief");
  const requestedCampaignId = params.get("videoCampaign");
  const requestedRoute = params.get("videoRoute");
  const bindingRequested = Boolean(requestedBriefId || requestedCampaignId || requestedRoute);
  const [binding, setBinding] = useState<BriefBinding | null>(null);
  const [bindingLoading, setBindingLoading] = useState(false);
  const [bindingError, setBindingError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [agentPaused, setAgentPaused] = useState(true);
  const [audioAgentPaused, setAudioAgentPaused] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [activeDraft, setActiveDraft] = useState<string | null>(null);
  const [activeReview, setActiveReview] = useState<string | null>(null);
  const [idea, setIdea] = useState("");
  const [audience, setAudience] = useState("");
  const [note, setNote] = useState("");
  const [tone, setTone] = useState<"calm" | "confident" | "energetic">("confident");
  const [seconds, setSeconds] = useState(120);
  const [aspects, setAspects] = useState<Array<"16:9" | "9:16" | "1:1">>(["16:9"]);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId || !requestedBriefId) {
      setBinding(null);
      setBindingError(requestedCampaignId || requestedRoute
        ? "A campaign video must name its approved brief." : null);
      setBindingLoading(false); return;
    }
    let active = true;
    setBinding(null); setBindingError(null); setBindingLoading(true);
    void (async () => {
      const brief = await supabase.from("client_briefs")
        .select("id,title,body,media_type,status,source_idea_id")
        .eq("client_id", clientId).eq("id", requestedBriefId).maybeSingle();
      if (!active) return;
      if (brief.error || !brief.data || brief.data.media_type !== "video"
        || !["approved", "in_production", "complete"].includes(brief.data.status)) {
        setBindingError("This video brief is unavailable or is not approved.");
        setBindingLoading(false); return;
      }
      let routePackageId: string | null = null;
      let routeVersion: number | null = null;
      if (requestedCampaignId || requestedRoute) {
        if (!requestedCampaignId || !["paid", "organic"].includes(requestedRoute ?? "")
          || !brief.data.source_idea_id) {
          setBindingError("Choose an approved campaign brief and route together.");
          setBindingLoading(false); return;
        }
        const [idea, routePackage] = await Promise.all([
          supabase.from("client_ideas").select("id,campaign_id")
            .eq("client_id", clientId).eq("id", brief.data.source_idea_id)
            .maybeSingle(),
          supabase.from("campaign_route_packages_v6")
            .select("id,version").eq("client_id", clientId)
            .eq("campaign_id", requestedCampaignId).eq("route", requestedRoute!)
            .order("version", { ascending: false }).limit(1).maybeSingle(),
        ]);
        if (!active) return;
        if (idea.error || idea.data?.campaign_id !== requestedCampaignId
          || routePackage.error || !routePackage.data) {
          setBindingError("The brief and current campaign route could not be matched.");
          setBindingLoading(false); return;
        }
        routePackageId = routePackage.data.id;
        routeVersion = routePackage.data.version;
      }
      setBinding({ briefId: brief.data.id, title: brief.data.title,
        campaignId: requestedCampaignId, routePackageId,
        route: requestedRoute, routeVersion });
      setIdea([brief.data.title, brief.data.body].filter(Boolean).join(" — ").slice(0, 4000));
      setRequestKey(crypto.randomUUID());
      setBindingLoading(false);
    })();
    return () => { active = false; };
  }, [clientId, requestedBriefId, requestedCampaignId, requestedRoute]);

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
    if (!clientId || (bindingRequested && !binding)) return;
    setBusy(true); setError(null); setNotice(null);
    const result = await supabase.rpc("create_video_project_draft_v1", {
      p_client_id: clientId, p_idea: idea.trim(), p_audience: audience.trim(),
      p_tone: tone, p_target_length_sec: seconds, p_aspects: aspects,
      p_brief_id: binding?.briefId ?? undefined,
      p_campaign_id: binding?.campaignId ?? undefined,
      p_route_package_id: binding?.routePackageId ?? undefined,
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
    {bindingLoading && <p className="text-xs text-muted-foreground">Checking video brief and campaign route…</p>}
    {bindingError && <p role="alert" className="text-xs text-destructive">{bindingError}</p>}
    {binding && <p className="text-xs">Source brief: {binding.title}
      {binding.route && ` · ${binding.route} route v${binding.routeVersion}`}</p>}
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
      <fieldset className="space-y-1 text-xs"><legend>Video aspects</legend>
        {(["16:9", "9:16", "1:1"] as const).map((item) =>
          <label key={item} className="flex items-center gap-2">
            <input type="checkbox" aria-label={`Video aspect ${item}`}
              checked={aspects.includes(item)}
              onChange={() => setAspects((current) => current.includes(item)
                ? current.filter((value) => value !== item) : [...current, item])} />
            {item}</label>)}
        <p className="text-muted-foreground">Choose at least one. The first aspect supplies the human-review asset.</p>
      </fieldset>
    </div>
    <button type="button" disabled={busy || Boolean(bindingRequested && !binding)
      || aspects.length === 0
      || idea.trim().length < 15 || !audience.trim()
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
        <div className="flex shrink-0 gap-3">
          {project.stage === "draft" && <button type="button" onClick={() => { setActiveDraft(project.id); setSelected([]); setNote(""); }}
            className="text-brand-strong hover:underline">Choose sources</button>}
          <button type="button" onClick={() => setActiveReview((current) => current === project.id ? null : project.id)}
            aria-expanded={activeReview === project.id}
            className="text-brand-strong hover:underline">{activeReview === project.id ? "Hide review" : "Inspect video"}</button>
        </div>
      </div>)}
      {clientId && activeReview && projects.some((project) => project.id === activeReview)
        && <CodeVideoProjectReviewPanel clientId={clientId} projectId={activeReview}
          stage={projects.find((project) => project.id === activeReview)!.stage} />}
    </div>
    <CodeVideoRenderCandidatesPanel clientId={clientId}
      titles={new Map(projects.map((project) => [project.id, project.idea]))} />
    <CodeVideoAttachmentsPanel clientId={clientId}
      titles={new Map(projects.map((project) => [project.id, project.idea]))} />
  </section>;
}
