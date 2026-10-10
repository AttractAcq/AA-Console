import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { MediaLibrary } from "../../components/MediaLibrary";
import { supabase } from "../../lib/supabase";
import { signPaths } from "../../lib/media";

type Reel = {
  id: string;
  title: string | null;
  ref_number: string | null;
  render_path: string | null;
  review_status: string;
  brief_id: string | null;
  edit_stage?: string;
};

/** Finished reels play their cut; in-progress reels lead to shot review. */
export function VideoLibraryPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const [reels, setReels] = useState<Reel[]>([]);
  const [cuts, setCuts] = useState<ReadonlyMap<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data, error: queryError } = await supabase.from("client_media_assets")
          .select("id, title, ref_number, render_path, review_status, brief_id, edit_stage")
          .eq("client_id", clientId)
          .eq("media_type", "video")
          .eq("content_format", "reel")
          .order("created_at", { ascending: false });
        if (queryError) throw queryError;
        const rows = (data ?? []) as Reel[];
        const signed = await signPaths("client-media", rows.map((r) => r.render_path ?? "").filter(Boolean));
        if (!cancelled) {
          setReels(rows);
          setCuts(signed);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load reels.");
      }
    })();
    return () => { cancelled = true; };
  }, [clientId]);

  const finished = reels.filter((r) => r.render_path && r.edit_stage !== "edited");
  const rawFootage = reels.filter((r) => r.edit_stage === "needs_edit" || r.edit_stage === "editing");
  const inProgress = reels.filter((r) => (!r.edit_stage || r.edit_stage === "review_ready") && !r.render_path).length;
  return (
    <div>
      {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
      {rawFootage.length > 0 && <p className="mb-4 text-sm text-muted-foreground">
        {rawFootage.length} source video{rawFootage.length === 1 ? " is" : "s are"} in Edit / Repurpose.{" "}
        <button type="button" className="font-medium text-brand-strong hover:underline"
          onClick={() => navigate(`/clients/${clientId}/delivery/edit-repurpose?tab=overview`)}>
          Open editing work
        </button>
      </p>}
      {inProgress > 0 && (
        <p className="mb-4 text-sm text-muted-foreground">
          {inProgress} reel{inProgress === 1 ? " is" : "s are"} in Create / Edit. Follow its clips and cut under{" "}
          <button type="button" className="font-medium text-brand-strong hover:underline"
            onClick={() => setSearchParams({ tab: "reel-shots" })}>Reel shots</button>.
        </p>
      )}
      {finished.length > 0 && (
        <section className="mb-6 space-y-3" aria-label="Finished reels">
          <h2 className="text-sm font-semibold text-foreground">Finished reels</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {finished.map((reel) => (
              <article key={reel.id} className="space-y-2 rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-medium">{reel.title || reel.ref_number || "Reel"}</h3>
                  <span className="text-xs capitalize text-muted-foreground">{reel.review_status}</span>
                </div>
                {cuts.get(reel.render_path!) ? (
                  <video controls preload="metadata" className="w-full rounded-md" src={cuts.get(reel.render_path!)} />
                ) : <p className="text-xs text-muted-foreground">Preview unavailable. Open Reel shots to review the cut.</p>}
                <button type="button" className="text-xs font-medium text-brand-strong hover:underline"
                  onClick={() => setSearchParams({ tab: "reel-shots", brief: reel.brief_id ?? "" })}>
                  View production and approval
                </button>
              </article>
            ))}
          </div>
        </section>
      )}
      <MediaLibrary mediaType="video" />
    </div>
  );
}
