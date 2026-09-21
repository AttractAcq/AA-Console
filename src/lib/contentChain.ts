import { supabase } from "./supabase";

/**
 * One archived piece of content production, as the archive lists it.
 *
 * Keyed on brief_ref rather than the asset's ref_number. They are different
 * numbers drawn from the same per-client counter — the carousel smoke test
 * burned AA-0066 for its brief and AA-0067 for its asset — and only
 * brief_ref spans the chain: one brief_ref covered both AA-0067 and AA-0068
 * once frame three was rebuilt, and content_attribution is already keyed on
 * it. Keying the archive on the asset ref would file one piece of work twice
 * and leave the idea with nowhere to sit.
 */
export type ArchiveRow = {
  client_id: string;
  brief_ref: string;
  brief_id: string;
  title: string;
  media_type: string;
  content_format: string;
  archived_at: string;
  idea_id: string | null;
  idea_title: string | null;
  content_territory: string | null;
  pillar_name: string | null;
  frame_count: number | null;
  assets: number;
  approved_assets: number;
  scheduled: number;
  published: number;
  iterations: number;
  first_published: string | null;
};

/** The six stages a piece of content passes through, in the order it passes them. */
export const CHAIN_STAGES = [
  { id: "ideation", label: "Ideation" },
  { id: "brief", label: "Brief" },
  { id: "asset", label: "Asset" },
  { id: "distribution", label: "Distribution" },
  { id: "reporting", label: "Reporting" },
  { id: "iteration", label: "Iteration" },
] as const;

export type ChainStage = (typeof CHAIN_STAGES)[number]["id"];

/**
 * How far this piece actually got, read off the records.
 *
 * Deliberately the furthest stage with something in it rather than a status
 * column. A status says what somebody intended; the records say what
 * happened, and the two disagree exactly when it matters — a piece marked
 * complete that was never scheduled, say.
 */
export function stageReached(row: ArchiveRow): ChainStage {
  if (row.published > 0) return "reporting";
  if (row.scheduled > 0) return "distribution";
  if (row.assets > 0) return "asset";
  return "brief";
}

/** Plain-language summary of where a piece stopped, for the list. */
export function stageLabel(row: ArchiveRow): string {
  if (row.published > 0) {
    return `Published${row.published > 1 ? ` ×${row.published}` : ""}`;
  }
  if (row.scheduled > 0) return "Scheduled, not yet out";

  if (row.approved_assets > 0) return "Approved, not scheduled";
  if (row.assets > 0) return "Built, awaiting approval";
  return "Brief only";
}

export async function fetchArchive(clientId: string): Promise<ArchiveRow[]> {
  const { data, error } = await supabase
    .from("content_archive")
    .select("*")
    .eq("client_id", clientId)
    .order("archived_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as ArchiveRow[];
}

/**
 * Whether a search term matches this row.
 *
 * Ref number first, because the archive is meant to be read by ref — that is
 * the whole point of keying it on one. Title and territory follow, because
 * nobody remembers a ref for something they only half-recall.
 */
export function matchesSearch(row: ArchiveRow, term: string): boolean {
  const q = term.trim().toLowerCase();
  if (!q) return true;
  return [row.brief_ref, row.title, row.idea_title, row.content_territory, row.pillar_name]
    .some((field) => (field ?? "").toLowerCase().includes(q));
}
