import { useCallback, useEffect, useState } from "react";
import { FormModal } from "../../components/forms/FormModal";
import { supabase } from "../../lib/supabase";
import { useSignedPreviewPaths } from "../../lib/useSignedPreviewPaths";
import type { Database } from "../../types/database";

export type ReelPreview = Database["public"]["Tables"]["faceless_reel_previews_v1"]["Row"];
type Scene = { position: number; caption: string; seconds: number };
type Board = { id: string; digest: string; scenes: Scene[]; campaign: string };
const button = "rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50";

export function FacelessReelStoryboard({ preview, briefRef, updatedAt, reload }: {
  preview: ReelPreview; briefRef: string | null; updatedAt: string; reload: () => Promise<void>;
}) {
  const [board, setBoard] = useState<Board | null>(null);
  const [editing, setEditing] = useState<Scene | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { client_id: client, brief_id: brief, project_id: project } = preview;
  const urls = useSignedPreviewPaths("client-media", [preview.storage_path]);
  const url = preview.storage_path && urls.get(preview.storage_path);

  const read = useCallback(async () => {
    if (!project) return null;
    const [p, rows] = await Promise.all([
      supabase.from("video_projects").select("id,source_digest,source_snapshot")
        .eq("client_id",client).eq("brief_id",brief).eq("id",project).single(),
      supabase.from("video_scenes").select("position,props,duration_sec").eq("client_id",client)
        .eq("project_id",project).order("position"),
    ]);
    if (p.error || rows.error) throw new Error(p.error?.message ?? rows.error?.message);
    const source = Array.isArray(p.data.source_snapshot) && p.data.source_snapshot[0];
    if (!source || typeof source !== "object" || Array.isArray(source) || typeof source.campaign_id !== "string"
        || !p.data.source_digest || rows.data.length !== 7) throw new Error("Incomplete storyboard source.");
    const scenes = rows.data.map(s => {
      if (!s.props || typeof s.props !== "object" || Array.isArray(s.props)
        || typeof s.props.caption !== "string" || !s.duration_sec) throw new Error("Incomplete storyboard scene.");
      return { position:s.position, caption:s.props.caption, seconds:s.duration_sec };
    });
    return { id:p.data.id, digest:p.data.source_digest, scenes, campaign:source.campaign_id };
  }, [client, brief, project]);
  useEffect(() => {
    let active = true;
    void read().then(result => { if (active) { setBoard(result); setError(""); } },
      err => { if (active) setError(String(err.message)); });
    return () => { active = false; };
  }, [read, preview.filed_at]);

  async function prepare() {
    setBusy(true); setError("");
    try {
      const result = await supabase.rpc("prepare_faceless_reel_preview_v1", {
        p_client_id:client, p_brief_id:brief, p_expected_updated_at:updatedAt,
      });
      if (result.error) throw result.error;
      await reload();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return <section aria-label="Motion storyboard" className="mb-4 space-y-3 rounded-lg border border-border p-4">
    <h2 className="text-sm font-semibold">Motion storyboard</h2>
    {!project && <button type="button" className={button} disabled={busy || updatedAt !== preview.reviewed_updated_at}
      onClick={() => void prepare()}>Approve brief and save storyboard</button>}
    <a className="block text-sm underline" href={`/clients/${client}/delivery/content-production-factory?tab=briefs&brief=${brief}`}>Source brief · {briefRef ?? brief}</a>
    {board && board.id === project && <>
      <a className="text-sm underline" href={`/clients/${client}/delivery/campaign-factory/${board.campaign}`}>Source campaign</a>
      <ol className="space-y-2">{board.scenes.map(s => <li key={s.position} className="flex items-baseline justify-between gap-4 text-sm">
        <span>{s.position}. {s.caption} <span className="text-muted-foreground">· {s.seconds}s</span></span>
        {!preview.filed_at && <button type="button" className="underline" onClick={() => setEditing(s)}>Edit scene {s.position}</button>}
      </li>)}</ol>
    </>}
    {url && <div><p className="text-sm">Draft preview · Pending review</p>
      <video controls playsInline preload="metadata" aria-label="Faceless reel draft" src={url} className="mt-2 max-h-[70vh] max-w-full" /></div>}
    {error && <p role="alert">{error}</p>}
    {editing && board && board.id === project && !preview.filed_at && <FormModal open title={`Edit scene ${editing.position}`} submitLabel="Save scene"
      fields={[{ name:"caption",label:"Caption",kind:"textarea",required:true },
        { name:"seconds",label:"Duration in seconds",kind:"number",required:true }]}
      initialValues={{caption:editing.caption,seconds:String(editing.seconds)}}
      onClose={() => setEditing(null)} onSubmit={async values => {
        const result = await supabase.rpc("edit_faceless_reel_scene_v1", {p_client_id:client,
          p_project_id:board.id, p_source_digest:board.digest, p_position:editing.position,
          p_caption:String(values.caption).trim(), p_duration_sec:Number(values.seconds)});
        if (result.error) throw result.error;
        setBoard(await read()); setEditing(null);
      }}/>}
  </section>;
}
