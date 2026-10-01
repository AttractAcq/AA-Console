/**
 * Phase 1 reel shots, as an operator reads them.
 *
 * The plan lives on the brief (frame_plan, one JSON object per shot).
 * Stills and clips, when they exist, live on client_media_frames. A reel
 * can be approved before either file exists, so the grid has to show the
 * plan on its own.
 */

export function isPhase1MotionBrief(
  brief: {
    media_type?: string | null;
    content_format?: string | null;
    format_code?: string | null;
  } | null | undefined,
): boolean {
  if (!brief || brief.media_type !== "video") return false;
  const code = brief.format_code?.trim() || null;
  if (code === "F6" || code === "F7") return true;
  return brief.content_format === "reel" && code === null;
}

export type PlannedShot = {
  beat: string;
  durationSec: number | null;
  sourceKind: string | null;
  motionPreset: string | null;
};

export type ReelFrameRow = {
  asset_id: string;
  position: number;
  storage_path: string | null;
  caption: string | null;
  beat: string | null;
  duration_sec: number | null;
  motion_preset: string | null;
  clip_path: string | null;
  shot_source_kind: string | null;
  provider_job_id: string | null;
};

export type ShotRow = {
  position: number;
  beat: string;
  durationLabel: string;
  source: string;
  motion: string;
  still: "No still" | "Still on file";
  clip: "No clip" | "Submitted" | "Clip on file";
};

export type ReelAssetReview = {
  id: string;
  brief_id: string | null;
  title: string | null;
  ref_number: string | null;
  review_status: "pending" | "approved" | "rejected";
};

export type ReelBriefInput = {
  id: string;
  title: string;
  brief_ref: string | null;
  status: string;
  content_format: string | null;
  format_code: string | null;
  frame_plan: string[] | null;
  media_type: string;
};

export type ReelMasterView = {
  briefId: string;
  title: string;
  briefRef: string | null;
  formatCode: string | null;
  briefStatus: string;
  planProblem: string | null;
  plannedShots: ShotRow[];
  assets: Array<{
    id: string;
    title: string | null;
    refNumber: string | null;
    reviewStatus: "pending" | "approved" | "rejected";
    shots: ShotRow[];
  }>;
};

function sourceLabel(kind: string | null | undefined): string {
  if (kind === "ai_generated") return "Generated";
  if (kind === "source_asset") return "Client asset";
  return "—";
}

function durationLabel(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  return `${seconds}s`;
}

/** One stored frame_plan line. Plain carousel text is not a shot. */
export function parseShotLine(line: string, index: number): { shot: PlannedShot | null; problem: string | null } {
  const label = `Shot ${index + 1}`;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { shot: null, problem: `${label} of the stored plan is not a shot record.` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { shot: null, problem: `${label} of the stored plan is not a shot record.` };
  }
  const row = raw as Record<string, unknown>;
  const beat = typeof row.beat === "string" ? row.beat.trim() : "";
  if (!beat) return { shot: null, problem: `${label} has no beat.` };
  const duration = row.duration_sec;
  const durationSec =
    typeof duration === "number" && Number.isFinite(duration) ? duration : null;
  const source = typeof row.shot_source_kind === "string" ? row.shot_source_kind : null;
  const motion = typeof row.motion_preset === "string" ? row.motion_preset.trim() : "";
  return {
    shot: {
      beat,
      durationSec,
      sourceKind: source,
      motionPreset: motion || null,
    },
    problem: null,
  };
}

export function readShotPlan(lines: string[] | null | undefined): {
  shots: PlannedShot[];
  problem: string | null;
} {
  if (!lines || lines.length === 0) {
    return { shots: [], problem: "This reel brief has no shot plan." };
  }
  const shots: PlannedShot[] = [];
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseShotLine(lines[i] ?? "", i);
    if (!parsed.shot) return { shots: [], problem: parsed.problem };
    shots.push(parsed.shot);
  }
  return { shots, problem: null };
}

function clipState(frame: ReelFrameRow | undefined): ShotRow["clip"] {
  if (frame?.clip_path?.trim()) return "Clip on file";
  if (frame?.provider_job_id?.trim()) return "Submitted";
  return "No clip";
}

export function shotRows(plan: PlannedShot[], frames: ReelFrameRow[]): ShotRow[] {
  const byPosition = new Map(frames.map((frame) => [frame.position, frame]));
  const frameMax = frames.reduce((max, frame) => Math.max(max, frame.position), 0);
  const count = Math.max(plan.length, frameMax);
  const rows: ShotRow[] = [];
  for (let position = 1; position <= count; position++) {
    const planned = plan[position - 1];
    const frame = byPosition.get(position);
    const beat = planned?.beat || frame?.beat?.trim() || frame?.caption?.trim() || "—";
    const duration = planned?.durationSec ?? frame?.duration_sec ?? null;
    const source = planned?.sourceKind ?? frame?.shot_source_kind ?? null;
    const motion = planned?.motionPreset || frame?.motion_preset?.trim() || "—";
    rows.push({
      position,
      beat,
      durationLabel: durationLabel(duration),
      source: sourceLabel(source),
      motion,
      still: frame?.storage_path?.trim() ? "Still on file" : "No still",
      clip: clipState(frame),
    });
  }
  return rows;
}

export function buildReelMasters(
  briefs: ReelBriefInput[],
  assets: ReelAssetReview[],
  frames: ReelFrameRow[],
): ReelMasterView[] {
  return briefs.filter(isPhase1MotionBrief).map((brief) => {
    const plan = readShotPlan(brief.frame_plan);
    const owned = assets.filter((asset) => asset.brief_id === brief.id);
    return {
      briefId: brief.id,
      title: brief.title,
      briefRef: brief.brief_ref,
      formatCode: brief.format_code,
      briefStatus: brief.status,
      planProblem: plan.problem,
      plannedShots: plan.shots.length > 0 ? shotRows(plan.shots, []) : [],
      assets: owned.map((asset) => ({
        id: asset.id,
        title: asset.title,
        refNumber: asset.ref_number,
        reviewStatus: asset.review_status,
        shots: shotRows(
          plan.shots,
          frames.filter((frame) => frame.asset_id === asset.id),
        ),
      })),
    };
  });
}
