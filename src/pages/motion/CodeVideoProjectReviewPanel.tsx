import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import type { Database, Json } from "../../types/database";

type Scene = Database["public"]["Tables"]["video_scenes"]["Row"];
type Attempt = Database["public"]["Tables"]["video_project_prerender_attempts_v1"]["Row"];
type VisualPatch = Database["public"]["Tables"]["video_project_visual_patches_v1"]["Row"];
type NarrationPatch = Database["public"]["Tables"]["video_project_narration_patches_v1"]["Row"];
type ReviewCheck = { area: string; verdict: string; sceneId: string | null;
  reason: string };
type ReviewPatch = { op: string; sceneId: string; path: string | null;
  value: Json | undefined };

const AREAS = ["text_overflow", "caption_overlap", "contrast", "safe_area",
  "reading_time", "brand_token", "empty_frame", "narration_visual_match"];

function object(value: Json | null | undefined): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function reviewChecks(value: Json | undefined): ReviewCheck[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = object(entry);
    return typeof row.area === "string" && typeof row.verdict === "string"
      && typeof row.reason === "string"
      ? [{ area: row.area, verdict: row.verdict,
        sceneId: typeof row.sceneId === "string" ? row.sceneId : null,
        reason: row.reason }] : [];
  });
}

function reviewPatches(value: Json | undefined): ReviewPatch[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = object(entry);
    return typeof row.op === "string" && typeof row.sceneId === "string"
      ? [{ op: row.op, sceneId: row.sceneId,
        path: typeof row.path === "string" ? row.path : null,
        value: row.value }] : [];
  });
}

function formatMoney(value: number | null): string {
  return value === null ? "unknown" : `$${Number(value).toFixed(4)}`;
}

/** Exact pre-render decisions and current scene/audio state for one project.
 * The UI reads receipts only; it cannot approve or start an outward action.
 */
export function CodeVideoProjectReviewPanel({ clientId, projectId, stage }: {
  clientId: string; projectId: string; stage: string;
}) {
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [visual, setVisual] = useState<VisualPatch[]>([]);
  const [narration, setNarration] = useState<NarrationPatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true); setError(null);
    void (async () => {
      const [sceneResult, attemptResult, visualResult, narrationResult] =
        await Promise.all([
          supabase.from("video_scenes").select("*")
            .eq("client_id", clientId).eq("project_id", projectId)
            .order("position"),
          supabase.from("video_project_prerender_attempts_v1").select("*")
            .eq("client_id", clientId).eq("project_id", projectId)
            .order("ir_version").limit(10),
          supabase.from("video_project_visual_patches_v1").select("*")
            .eq("client_id", clientId).eq("project_id", projectId),
          supabase.from("video_project_narration_patches_v1").select("*")
            .eq("client_id", clientId).eq("project_id", projectId),
        ]);
      if (!active) return;
      const failure = sceneResult.error ?? attemptResult.error
        ?? visualResult.error ?? narrationResult.error;
      if (failure) { setError(failure.message); setLoading(false); return; }
      setScenes(sceneResult.data ?? []);
      setAttempts(attemptResult.data ?? []);
      setVisual(visualResult.data ?? []);
      setNarration(narrationResult.data ?? []);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [clientId, projectId]);

  const changed = new Set([...visual.flatMap((patch) => patch.changed_scene_ids),
    ...narration.flatMap((patch) => patch.changed_scene_ids)]);
  return <section aria-label="Video project review history" className="space-y-3 rounded-md border border-border p-3 text-xs">
    <h4 className="font-semibold">Scenes and critic history</h4>
    {stage === "needs_human" && <p className="text-destructive">The review limit was reached. A person must revise this project.</p>}
    {loading && <p className="text-muted-foreground">Loading exact review history…</p>}
    {error && <p role="alert" className="text-destructive">Could not load review history: {error}</p>}
    {!loading && !error && <>
      <div className="space-y-2">
        <h5 className="font-medium">Current scenes</h5>
        {scenes.length === 0 && <p className="text-muted-foreground">No storyboard scenes yet.</p>}
        {scenes.map((scene) => <article key={scene.id} className="rounded-md border border-border p-2">
          <p className="font-medium">{scene.scene_key} · {scene.component}
            {changed.has(scene.scene_key) && " · changed by critic"}
            {scene.locked && " · locked"}</p>
          <p className="mt-1 whitespace-pre-wrap">{scene.narration}</p>
          <p className="text-muted-foreground">Audio: {scene.audio_path ? "filed" : "pending"}
            {scene.duration_sec !== null ? ` · ${scene.duration_sec}s` : ""}</p>
        </article>)}
      </div>
      <div className="space-y-2">
        <h5 className="font-medium">Pre-render decisions · {attempts.length}</h5>
        {attempts.length === 0 && <p className="text-muted-foreground">No pre-render decision yet.</p>}
        {attempts.map((attempt) => {
          const report = object(attempt.report);
          const checks = reviewChecks(report.checks);
          const patches = reviewPatches(report.patch);
          const revision = visual.find((patch) => patch.attempt_id === attempt.id)
            ?? narration.find((patch) => patch.attempt_id === attempt.id);
          return <article key={attempt.id} className="rounded-md border border-border p-2">
            <p className="font-medium">IR v{attempt.ir_version} · {attempt.state}
              {attempt.result ? ` · ${attempt.result}` : ""}</p>
            <p className="text-muted-foreground">Claimed {attempt.claimed_at}
              {attempt.decided_at ? ` · decided ${attempt.decided_at}` : ""}
              {` · stills ${formatMoney(attempt.still_usd)}`}
              {` · model ${formatMoney(attempt.model_usd)}`}</p>
            {revision && <p>Revision committed: v{revision.from_ir_version} → v{revision.to_ir_version}
              {` · scenes ${revision.changed_scene_ids.join(", ")}`}</p>}
            {checks.length > 0 && <div className="mt-2 space-y-1" aria-label={`IR v${attempt.ir_version} critic checks`}>
              {AREAS.flatMap((area) => checks.filter((check) => check.area === area))
                .map((check, index) => <p key={`${check.area}-${index}`}
                  className={check.verdict === "fail" ? "text-destructive" : undefined}>
                  {check.area.replace(/_/g, " ")} · {check.verdict}
                  {check.sceneId ? ` · ${check.sceneId}` : ""}: {check.reason}</p>)}
            </div>}
            {patches.length > 0 && <details className="mt-2"><summary className="cursor-pointer">Filed patch operations</summary>
              {patches.map((patch, index) => <p key={index} className="break-words">
                {patch.sceneId} · {patch.op}{patch.path ? ` · ${patch.path}` : ""}
                {patch.value !== undefined ? ` → ${JSON.stringify(patch.value)}` : ""}</p>)}
            </details>}
          </article>;
        })}
      </div>
    </>}
  </section>;
}
