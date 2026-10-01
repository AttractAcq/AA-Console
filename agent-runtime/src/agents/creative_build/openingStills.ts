import { isPhase1FormatCode, parseStoredShotPlan, type ShotPlanEntry } from "../brief/shots.js";
import type { FrameAsk } from "./frames.js";

/**
 * Phase 1 reel, matching build_brief_with_ai.
 *
 * F6 or F7, or a reel whose format code is still unset. A video story is
 * not one of these. A reel already tagged F1–F5 or F8–F10 is a later phase.
 */
export function isPhase1ReelBrief(brief: {
  media_type?: string | null;
  content_format?: string | null;
  format_code?: string | null;
}): boolean {
  if (brief.media_type !== "video") return false;
  if (isPhase1FormatCode(brief.format_code)) return true;
  return brief.content_format === "reel" && (brief.format_code == null || brief.format_code === "");
}

export type OpeningStillsRoute =
  | { kind: "standard" }
  | { kind: "stills"; shots: ShotPlanEntry[]; frameAsk: FrameAsk }
  | { kind: "refuse"; message: string };

/**
 * Whether creative_build may render this brief.
 *
 * A reel's opening still is an image. creative_generations rejects
 * media_type video, so the queued generation is image-typed and the brief
 * stays a video. Carousel, story and single stills never enter this branch:
 * their briefs are not video, so they stay on the route they already had.
 * A video story, and a reel that is not Phase 1, stay human work.
 */
export function openingStillsRoute(
  brief: {
    media_type?: string | null;
    content_format?: string | null;
    format_code?: string | null;
    frame_plan?: string[] | null;
  },
  generationMediaType: string,
): OpeningStillsRoute {
  if (brief.media_type !== "video") return { kind: "standard" };
  if (!isPhase1ReelBrief(brief)) {
    if (brief.content_format === "reel") {
      return {
        kind: "refuse",
        message: `Phase 1 video build is F6 or F7. This reel is ${brief.format_code ?? "unspecified"}. Send it to an editor.`,
      };
    }
    return {
      kind: "refuse",
      message: "Video is produced by people. Send this brief to an editor or avatar instead.",
    };
  }
  if (generationMediaType !== "image") {
    return {
      kind: "refuse",
      message: "Opening stills are images. This generation is not an image, so it was not rendered.",
    };
  }
  const plan = parseStoredShotPlan(brief.frame_plan);
  if (plan.problem) return { kind: "refuse", message: plan.problem };
  return {
    kind: "stills",
    shots: plan.shots,
    frameAsk: {
      count: plan.shots.length,
      plan: plan.shots.map((shot) => shot.beat),
    },
  };
}

/** Shot columns filed beside each opening still. Carousel frames do not use this. */
export function withOpeningShotFields<T extends { position: number }>(
  frames: readonly T[],
  shots: readonly ShotPlanEntry[],
): Array<
  T & {
    beat: string | null;
    duration_sec: number | null;
    motion_preset: string | null;
    shot_source_kind: string | null;
  }
> {
  return frames.map((frame) => {
    const shot = shots[frame.position - 1];
    return {
      ...frame,
      beat: shot?.beat ?? null,
      duration_sec: shot?.duration_sec ?? null,
      motion_preset: shot?.motion_preset ?? null,
      shot_source_kind: shot?.shot_source_kind ?? null,
    };
  });
}
