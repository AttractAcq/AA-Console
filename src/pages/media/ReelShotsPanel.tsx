import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { ReelShotGrid } from "../../components/ReelShotGrid";
import { supabase } from "../../lib/supabase";
import { buildReelMasters } from "../../lib/reelShots";
import type {
  ReelAssetReview,
  ReelBriefInput,
  ReelEditJob,
  ReelFrameRow,
  ReelMasterView,
} from "../../lib/reelShots";

/**
 * Shot review for a Phase 1 reel.
 *
 * Beside the video library, which is finished files. This is the plan and
 * the state of each shot — still, clip, or neither — and the approve on
 * the master. No distribution and no assembly.
 */
export function ReelShotsPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [masters, setMasters] = useState<ReelMasterView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    if (!clientId) {
      setMasters([]);
      setLoading(false);
      return;
    }
    try {
      const briefRes = await supabase
        .from("client_briefs")
        .select("id, title, brief_ref, status, content_format, format_code, frame_plan, media_type")
        .eq("client_id", clientId)
        .eq("media_type", "video")
        .or("content_format.eq.reel,format_code.in.(F6,F7)")
        .is("archived_at", null)
        .order("created_at", { ascending: false });
      if (briefRes.error) throw briefRes.error;
      const briefs = (briefRes.data ?? []) as ReelBriefInput[];
      const ids = briefs.map((brief) => brief.id);
      const assetRes = ids.length
        ? await supabase
            .from("client_media_assets")
            .select("id, brief_id, title, ref_number, review_status, render_path")
            .eq("client_id", clientId)
            .in("brief_id", ids)
        : { data: [], error: null };
      if (assetRes.error) throw assetRes.error;
      const assets = (assetRes.data ?? []) as ReelAssetReview[];
      const assetIds = assets.map((asset) => asset.id);
      const frameRes = assetIds.length
        ? await supabase
            .from("client_media_frames")
            .select(
              "asset_id, position, storage_path, caption, beat, duration_sec, motion_preset, clip_path, shot_source_kind, provider_job_id",
            )
            .in("asset_id", assetIds)
            .order("position")
        : { data: [], error: null };
      if (frameRes.error) throw frameRes.error;
      // Newest first, so the first job for an asset is the one that says
      // where its cut has got to.
      const jobRes = assetIds.length
        ? await supabase
            .from("agent_jobs")
            .select("input_id, status, error")
            .eq("agent_key", "video_edit")
            .in("input_id", assetIds)
            .order("created_at", { ascending: false })
        : { data: [], error: null };
      if (jobRes.error) throw jobRes.error;
      setMasters(
        buildReelMasters(
          briefs,
          assets,
          (frameRes.data ?? []) as ReelFrameRow[],
          (jobRes.data ?? []) as ReelEditJob[],
        ),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : ((error as { message?: string }).message ?? "Unknown query error");
      setLoadError("Failed to load reel shots: " + message);
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loadError) {
    return (
      <div role="alert">
        <p>{loadError}</p>
        <button type="button" onClick={() => void refresh()}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div>
      {actionError && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {actionError}
        </p>
      )}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading reel shots…</p>
      ) : (
        <ReelShotGrid masters={masters} onChanged={() => void refresh()} onError={setActionError} />
      )}
    </div>
  );
}
