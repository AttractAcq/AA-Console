import { supabase } from "./supabase";

/**
 * How many frames each of these assets has.
 *
 * One query for the whole page rather than one per card: a library of thirty
 * carousels would otherwise be thirty round trips to render a count.
 */
export async function countFrames(assetIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (assetIds.length === 0) return counts;
  // A count is decoration, so it swallows everything: a returned error, and
  // a throw. The first version only handled the former, which meant a
  // failure here blanked the whole library behind an alert.
  try {
    const { data, error } = await supabase
      .from("client_media_frames")
      .select("asset_id")
      .in("asset_id", assetIds);
    if (error) return counts;
    for (const row of data ?? []) {
      const id = (row as { asset_id: string }).asset_id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  } catch {
    return counts;
  }
  return counts;
}

export interface Frame {
  id: string;
  position: number;
  storage_path: string;
  caption: string | null;
}

/** The frames of one asset, in the order they run. */
export async function fetchFrames(assetId: string): Promise<Frame[]> {
  const { data, error } = await supabase
    .from("client_media_frames")
    .select("id, position, storage_path, caption")
    .eq("asset_id", assetId)
    .order("position");
  if (error) throw new Error(error.message);
  return (data ?? []) as Frame[];
}
