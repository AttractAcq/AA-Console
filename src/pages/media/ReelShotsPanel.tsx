import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { ReelShotGrid } from "../../components/ReelShotGrid";
import { supabase } from "../../lib/supabase";
import { buildReelMasters } from "../../lib/reelShots";
import { useSignedPreviewPaths } from "../../lib/useSignedPreviewPaths";
import { useAgentJobs } from "../../lib/useAgentJobs";
import { AgentActivityBar } from "../../components/agents/AgentActivityBar";
import type {
  ReelAssetReview,
  ReelBriefInput,
  ReelEditJob,
  ReelFrameRow,
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
  const [searchParams] = useSearchParams();
  const focusedBrief = searchParams.get("brief");
  const [briefs, setBriefs] = useState<ReelBriefInput[]>([]);
  const [assets, setAssets] = useState<ReelAssetReview[]>([]);
  const [frames, setFrames] = useState<ReelFrameRow[]>([]);
  const [editJobs, setEditJobs] = useState<ReelEditJob[]>([]);
  const signedMedia = useSignedPreviewPaths("client-media", [
    ...assets.map((asset) => asset.render_path),
    ...frames.flatMap((frame) => [frame.storage_path, frame.clip_path]),
  ]);
  const masters = useMemo(() => buildReelMasters(briefs, assets, frames, editJobs, signedMedia),
    [briefs, assets, frames, editJobs, signedMedia]);
  const [buildJobs, setBuildJobs] = useState<ReadonlyMap<string, { status: string; error: string | null }>>(new Map());
  const [engineHeldIds, setEngineHeldIds] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retryingBrief, setRetryingBrief] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    if (!clientId) {
      setBriefs([]);
      setAssets([]);
      setFrames([]);
      setEditJobs([]);
      setLoading(false);
      return;
    }
    try {
      let briefQuery = supabase
        .from("client_briefs")
        .select("id, title, brief_ref, status, content_format, format_code, frame_plan, media_type")
        .eq("client_id", clientId)
        .eq("media_type", "video")
        .or("content_format.eq.reel,format_code.in.(F6,F7)")
        .order("created_at", { ascending: false });
      // Creating the first asset archives its brief. A reel remains in
      // production and review after that point, so its shots must stay here.
      briefQuery = focusedBrief ? briefQuery.eq("id", focusedBrief) : briefQuery.limit(100);
      const briefRes = await briefQuery;
      if (briefRes.error) throw briefRes.error;
      const briefs = (briefRes.data ?? []) as ReelBriefInput[];
      const ids = briefs.map((brief) => brief.id);
      const assetRes = ids.length
        ? await supabase
            .from("client_media_assets")
            .select("id, brief_id, title, ref_number, review_status, human_approved_at, render_path")
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
      const slotRes = assetIds.length
        ? await supabase.from("content_slots")
            .select("asset_id")
            .eq("client_id", clientId)
            .eq("stage", "awaiting_approval")
            .in("asset_id", assetIds)
        : { data: [], error: null };
      if (slotRes.error) throw slotRes.error;
      const buildRes = ids.length
        ? await supabase.from("agent_jobs")
            .select("input_id, status, error")
            .eq("agent_key", "video_build")
            .in("input_id", ids)
            .order("created_at", { ascending: false })
        : { data: [], error: null };
      if (buildRes.error) throw buildRes.error;
      const latestBuilds = new Map<string, { status: string; error: string | null }>();
      for (const row of buildRes.data ?? []) {
        if (row.input_id && !latestBuilds.has(row.input_id)) latestBuilds.set(row.input_id, { status: row.status, error: row.error });
      }
      // Keep only object paths in state. The visible shot grid re-signs its
      // media through Storage authorization as the short preview URL ages.
      const frameFiles = (frameRes.data ?? []) as ReelFrameRow[];
      setBriefs(briefs);
      setAssets(assets);
      setFrames(frameFiles);
      setEditJobs((jobRes.data ?? []) as ReelEditJob[]);
      setBuildJobs(latestBuilds);
      setEngineHeldIds(new Set((slotRes.data ?? []).map((row) => row.asset_id).filter((id): id is string => Boolean(id))));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : ((error as { message?: string }).message ?? "Unknown query error");
      setLoadError("Failed to load reel shots: " + message);
    } finally {
      setLoading(false);
    }
  }, [clientId, focusedBrief]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  const { inFlight, recentFailures } = useAgentJobs(clientId, refresh);

  const retryBuild = async (briefId: string) => {
    setActionError(null);
    setRetryingBrief(briefId);
    try {
      const { error } = await supabase.rpc("retry_reel_video_build", { p_brief_id: briefId });
      if (error) throw error;
      await refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not retry the reel build.");
    } finally {
      setRetryingBrief(null);
    }
  };

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
      <AgentActivityBar inFlight={inFlight} failures={recentFailures} />
      {actionError && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {actionError}
        </p>
      )}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading reel shots…</p>
      ) : (
        <ReelShotGrid masters={masters} buildJobs={buildJobs} engineHeldIds={engineHeldIds} clientId={clientId}
          focusedBrief={focusedBrief}
          onChanged={() => void refresh()} onError={setActionError}
          onRetryBuild={(briefId) => void retryBuild(briefId)} retryingBrief={retryingBrief} />
      )}
    </div>
  );
}
