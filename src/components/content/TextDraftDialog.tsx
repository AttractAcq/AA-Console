import { useEffect, useState } from "react";
import { Modal } from "../Modal";
import { ConceptWorkspace, type Generation } from "../briefs/ConceptWorkspace";
import { supabase } from "../../lib/supabase";
import type { MediaAsset } from "../../lib/media";

export function TextDraftDialog({ asset, brief, onClose }: {
  asset: MediaAsset;
  brief: { id: string; title: string; brief_ref: string | null; body: string | null };
  onClose: () => void;
}) {
  const [generation, setGeneration] = useState<Generation | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let current = true;
    async function load() {
      const result = await supabase.from("creative_renders")
        .select("generation:creative_generations!inner(id,stage,concept,quality,size,reference_path,concept_model,image_model,concept_edited_at,cost_usd,error,created_at,media_type)")
        .eq("asset_id", asset.id).eq("client_id", asset.client_id)
        .eq("generation.client_id", asset.client_id).eq("generation.brief_id", brief.id)
        .eq("generation.media_type", "text").single();
      if (!current) return;
      if (result.error || !result.data?.generation) {
        setGeneration(null);
        setError("Could not load the saved text draft for this asset and source brief.");
        return;
      }
      setError("");
      setGeneration(result.data.generation as Generation);
    }
    void load().catch(() => {
      if (current) {
        setGeneration(null);
        setError("Could not load the saved text draft.");
      }
    });
    return () => { current = false; };
  }, [asset.id, asset.client_id, brief.id, revision]);

  return <Modal open title={asset.title ?? "Text draft"} onClose={onClose}>
    <p>Review state · {asset.review_status}</p>
    <details className="my-3">
      <summary>Source brief · {brief.brief_ref ?? brief.title}</summary>
      <p>{brief.title} · {brief.id}</p>
      <p className="whitespace-pre-wrap">{brief.body}</p>
    </details>
    {error ? <div role="alert">{error} <button type="button" onClick={() => setRevision(v => v + 1)}>Retry</button></div>
      : generation ? <ConceptWorkspace generation={generation} onChanged={() => setRevision(v => v + 1)} />
      : <p>Loading draft…</p>}
  </Modal>;
}
