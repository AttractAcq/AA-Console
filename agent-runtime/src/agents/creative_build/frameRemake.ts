/**
 * Rebuilding one frame of a set that is otherwise fine.
 *
 * The expensive mistake this avoids is re-rendering four frames you were
 * happy with in order to fix the fifth. The same rule as buildPlan and as
 * renderFrames' resume: never "do everything", always "do what is not
 * already right".
 *
 * The frames that are kept are COPIED into the new render's prefix rather
 * than referenced where they are. Referencing would be cheaper still, but it
 * makes the new asset depend on files belonging to an older render — and the
 * moment anything cleans up a deleted asset's storage, a carousel nobody
 * touched loses four of its five frames. Each asset owning its own files
 * keeps framePath's contract true: everything under a render's prefix
 * belongs to that render.
 */

import type { StoredFrame } from "./frames.js";

export interface FrameRemake {
  sourceAssetId: string;
  position: number;
}

/**
 * The remake this job is, or null if it is an ordinary build.
 *
 * Both halves must be present and usable. A job carrying a position but no
 * source asset is not a remake of anything, and treating it as one would
 * rebuild a set from frames that were never loaded.
 */
export function frameRemakeFromParams(params: Record<string, unknown>): FrameRemake | null {
  const sourceAssetId = typeof params.source_asset_id === "string" ? params.source_asset_id : "";
  const raw = params.frame_position;
  const position = typeof raw === "number" ? Math.floor(raw) : Number.NaN;
  if (!sourceAssetId || !Number.isInteger(position) || position < 1) return null;
  return { sourceAssetId, position };
}

/** Why this remake cannot be built from these frames, or null if it can. */
export function frameRemakeProblem(
  frames: readonly StoredFrame[],
  position: number,
): string | null {
  if (frames.length < 2) {
    return `That asset has ${frames.length} frame${frames.length === 1 ? "" : "s"}, so there is no set to rebuild part of.`;
  }
  if (!frames.some((f) => f.position === position)) {
    return `This set runs 1 to ${frames.length}; there is no frame ${position}.`;
  }
  return null;
}

/**
 * The frames carried over untouched.
 *
 * Everything but the one being replaced. These cost a storage copy each and
 * no image call, which is the whole point of the exercise.
 */
export function framesToCarry(
  frames: readonly StoredFrame[],
  position: number,
): StoredFrame[] {
  return frames.filter((f) => f.position !== position);
}

/**
 * The finished set: the carried frames and the new one, in running order.
 *
 * Sorted rather than spliced, because a set whose positions arrive out of
 * order would be filed in whatever order the rows came back and read as a
 * shuffled argument.
 */
export function remadeSet(
  carried: readonly StoredFrame[],
  replacement: StoredFrame,
): StoredFrame[] {
  return [...carried.filter((f) => f.position !== replacement.position), replacement].sort(
    (a, b) => a.position - b.position,
  );
}

/**
 * What the model is told about the frame it is replacing.
 *
 * The siblings are listed because a frame written without them comes back
 * repeating a point another frame already makes — the same failure the
 * pillar brief had when it named a wrong pillar without listing the right
 * ones. The frame's own former self is named as the thing being replaced so
 * the feedback has something to attach to.
 */
export function frameRemakeBrief(
  position: number,
  total: number,
  siblings: readonly { position: number; purpose: string; headline: string }[],
  feedback: string,
): string {
  const others = siblings
    .filter((s) => s.position !== position)
    .sort((a, b) => a.position - b.position)
    .map((s) => `- Frame ${s.position}: ${s.purpose}${s.headline ? ` ("${s.headline}")` : ""}`)
    .join("\n");

  return `You are replacing ONE frame of a ${total}-frame set that is otherwise finished and approved of.

Rewrite frame ${position} only. The other frames are staying exactly as they are:
${others || "- (the rest of the set carries no description)"}

WHAT IS WRONG WITH FRAME ${position}
${feedback}

Your replacement has to do frame ${position}'s job in the sequence, fix what is named above, and sit between its neighbours as one piece of work with them — same palette, same treatment, same world. Do not restate what another frame already says.`;
}

/**
 * Where a carried frame is copied to.
 *
 * The extension is taken from the file it came from: a copy that renames
 * .jpg to .png produces a file whose bytes and name disagree, and the
 * storage layer will happily serve it with the wrong content type.
 */
export function carriedFrameDestination(
  path: string,
  pathFor: (position: number, extension: string) => string,
  position: number,
): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  return pathFor(position, match?.[1] ?? "png");
}
