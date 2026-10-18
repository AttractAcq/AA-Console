import { supabase } from "./supabase";
import type { Database } from "../types/database";

/**
 * Archiving and deleting a piece of content production, from any stage.
 *
 * Two verbs that are deliberately not variations of each other.
 *
 * ARCHIVE moves a record out of the working list and nowhere else. Content
 * production already archives itself — migration 118 stamps an idea when its
 * brief appears and a brief when its asset appears — so this is the manual
 * version of the same stamp, for the times a person decides a thing is done
 * before the records do. Nothing is copied and nothing is lost, which is what
 * makes it safe to do on a hunch, and the Archive screen still shows every
 * stage a piece passed through.
 *
 * DELETE is the end of the thing. Not a flag, not a move: the asset, its
 * frames, its copy, its schedule, its reviews and its files in the bucket.
 * It leaves the archive too, because the archive is a view over these same
 * rows rather than a copy of them — there is no second place to clean up,
 * and anything that claimed otherwise would be describing a system this is
 * not.
 */

export type ContentRecord = "idea" | "brief" | "asset";

export async function setContentArchived(
  record: ContentRecord,
  id: string,
  archived = true,
): Promise<void> {
  const { error } = await supabase.rpc("set_content_archived_v6", {
    p_record: record,
    p_id: id,
    p_archived: archived,
  });
  if (error) throw new Error(error.message);
}

/**
 * What a termination actually removed, so the confirmation can say it.
 *
 * Taken from the generated types rather than restated, so the day a column is
 * added to the function's return the compiler says so here.
 */
export type AssetDeletion =
  Database["public"]["Functions"]["delete_content_asset_v6"]["Returns"][number];

export async function deleteContentAsset(id: string): Promise<AssetDeletion> {
  const { data, error } = await supabase.rpc("delete_content_asset_v6", { p_asset_id: id });
  if (error) throw new Error(error.message);
  // A set-returning function with nothing to say returns no rows rather than
  // a row of zeroes, and "deleted nothing" is a true thing to report.
  return data?.[0] ?? { deleted_frames: 0, deleted_copy: 0, deleted_posts: 0, deleted_files: 0 };
}

/** A brief, and everything made from it. Mirrors delete_client_idea's scope. */
export async function deleteContentBrief(id: string): Promise<AssetDeletion> {
  const { data, error } = await supabase.rpc("delete_content_brief_v6", { p_brief_id: id });
  if (error) throw new Error(error.message);
  // A set-returning function with nothing to say returns no rows rather than
  // a row of zeroes, and "deleted nothing" is a true thing to report.
  return data?.[0] ?? { deleted_frames: 0, deleted_copy: 0, deleted_posts: 0, deleted_files: 0 };
}

/**
 * A date for a table cell, or an em dash.
 *
 * `new Date(undefined).toISOString()` throws, and a row that reaches a table
 * without its timestamp should cost a dash rather than the whole screen.
 */
export function dayOrDash(iso: string | null | undefined): string {
  if (!iso) return "—";
  const day = new Date(iso);
  return Number.isNaN(day.getTime()) ? "—" : day.toISOString().slice(0, 10);
}

/** The sentence a person reads after a termination. */
export function deletionSummary(removed: AssetDeletion): string {
  const parts = [
    removed.deleted_frames > 0 ? `${removed.deleted_frames} frame${removed.deleted_frames === 1 ? "" : "s"}` : null,
    removed.deleted_files > 0 ? `${removed.deleted_files} file${removed.deleted_files === 1 ? "" : "s"}` : null,
    removed.deleted_posts > 0 ? `${removed.deleted_posts} scheduled post${removed.deleted_posts === 1 ? "" : "s"}` : null,
    removed.deleted_copy > 0 ? `${removed.deleted_copy} caption${removed.deleted_copy === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `Deleted, along with ${parts.join(", ")}.` : "Deleted.";
}

/** The warning before one. Names the bucket, because that part is not undoable. */
export const DELETE_BRIEF_WARNING =
  "Delete this brief entirely? Any asset made from it goes too, with its frames, captions, " +
  "scheduled posts and files in storage, and it leaves the archive. This cannot be undone.";

export const DELETE_ASSET_WARNING =
  "Delete this asset entirely? Its frames, captions, scheduled posts, reviews and its files " +
  "in storage all go with it, and it leaves the archive too. This cannot be undone.";
