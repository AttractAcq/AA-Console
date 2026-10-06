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
  /** Set once video_edit has rendered a cut. Null means nobody has asked, or it failed. */
  render_path?: string | null;
};

/** A video_edit job as the panel needs to read it. */
export type ReelEditJob = {
  input_id: string | null;
  status: string;
  error?: string | null;
};

export type CutState = {
  /** What the reel's cut is, in one word for the UI to branch on. */
  status: "cut" | "running" | "failed" | "ready" | "incomplete";
  /** What a person reads. Always says what is actually on file. */
  detail: string;
  /** Whether asking for a cut now would do anything. */
  canRequest: boolean;
};

const IN_FLIGHT = new Set(["queued", "claimed", "running"]);

/**
 * Whether this reel has a cut, is getting one, or could ask for one.
 *
 * Asking is allowed with clips missing, on purpose: request_video_edit says
 * nothing about readiness either, because the runner is what knows whether
 * the clips have landed and refusing in SQL means the answer never reaches
 * the person who pressed the button. So the line below states the gap and
 * the button stays live.
 */
export function cutState(
  asset: { render_path?: string | null },
  shots: readonly ShotRow[],
  jobs: readonly ReelEditJob[],
): CutState {
  if (asset.render_path?.trim()) {
    return { status: "cut", detail: "Cut on file.", canRequest: false };
  }
  const latest = jobs[0];
  if (latest && IN_FLIGHT.has(latest.status)) {
    return {
      status: "running",
      detail: latest.status === "queued" ? "Queued for cutting." : "Being cut now.",
      canRequest: false,
    };
  }

  const withClips = shots.filter((shot) => shot.clip === "Clip on file").length;
  const gap =
    shots.length === 0
      ? "No shots on this reel."
      : withClips === shots.length
        ? `All ${shots.length} clips on file.`
        : `${withClips} of ${shots.length} clips on file.`;

  if (latest && latest.status === "failed") {
    return {
      status: "failed",
      // The reason the runner gave, not a generic one: it is the only part
      // of the failure anyone can act on.
      detail: `Last cut failed: ${latest.error?.trim() || "no reason recorded"}. ${gap}`,
      canRequest: true,
    };
  }

  return {
    status: withClips === shots.length && shots.length > 0 ? "ready" : "incomplete",
    detail: gap,
    canRequest: true,
  };
}

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
    cut: CutState;
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
  editJobs: ReelEditJob[] = [],
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
      assets: owned.map((asset) => {
        const shots = shotRows(
          plan.shots,
          frames.filter((frame) => frame.asset_id === asset.id),
        );
        return {
          id: asset.id,
          title: asset.title,
          refNumber: asset.ref_number,
          reviewStatus: asset.review_status,
          shots,
          // Newest first, as the panel queries them: the latest job is the
          // one that says where this reel's cut has got to.
          cut: cutState(asset, shots, editJobs.filter((job) => job.input_id === asset.id)),
        };
      }),
    };
  });
}
