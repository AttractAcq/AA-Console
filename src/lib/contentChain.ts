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
    return `Publication recorded${row.published > 1 ? ` ×${row.published}` : ""}`;
  }
  if (row.scheduled > 0) return "Scheduled, not yet out";

  if (row.approved_assets > 0) return "Approved, not scheduled";
  if (row.assets > 0) return "Built, awaiting approval";
  return "Brief only";
}

/** A recorded publish transition is not a provider read-back. */
export function publicationEvidence(post: {
  published_at: string | null;
  external_id: string | null;
  external_url: string | null;
}): string | null {
  if (!post.published_at) return null;
  return post.external_id || post.external_url
    ? "External reference recorded; provider read-back unverified"
    : "Publication recorded without an external reference; provider result unverified";
}

export type ArchiveMetricCoverage = {
  linked_posts: number;
  metric_rows: number;
  posts_with_metrics: number;
  cumulative_rows: number;
  impression_rows: number;
  reach_rows: number;
  click_rows: number;
  spend_rows: number;
  currency_count: number;
  missing_currency_rows: number;
  currency: string | null;
  first_metric_date: string | null;
  last_metric_date: string | null;
  last_fetched_at: string | null;
};

/** Legacy sums are useful only when their underlying rows are visible. */
export function archiveMetricPresentation(
  totals: { impressions: number | null; reach: number | null; clicks: number | null; spend: number | null },
  coverage: ArchiveMetricCoverage | null,
): Record<string, string> {
  if (!coverage) return {
    metric_coverage: "unknown (coverage read unavailable)",
    impressions: "unknown", reach: "unknown", clicks: "unknown", spend: "unknown",
  };
  const scope = coverage.metric_rows > 0
    ? `${coverage.metric_rows} metric rows on ${coverage.posts_with_metrics}/${coverage.linked_posts} linked posts; ${coverage.first_metric_date ?? "unknown"} to ${coverage.last_metric_date ?? "unknown"}; fetched ${coverage.last_fetched_at ?? "unknown"}; provider completeness unverified`
    : `${coverage.linked_posts} linked posts; no ingested metric rows`;
  const metric = (value: number | null, observedRows: number) => {
    if (observedRows === 0 || value === null) return "unknown (no ingested value)";
    if (coverage.cumulative_rows > 0) return "unknown (legacy sum includes cumulative snapshots)";
    return `${value} (recorded daily rows; coverage unverified)`;
  };
  const spend = coverage.spend_rows > 0 &&
    (coverage.currency_count !== 1 || coverage.missing_currency_rows > 0)
    ? "unknown (spend currency missing or mixed)"
    : metric(totals.spend, coverage.spend_rows);
  return {
    metric_coverage: scope,
    impressions: metric(totals.impressions, coverage.impression_rows),
    reach: metric(totals.reach, coverage.reach_rows),
    clicks: metric(totals.clicks, coverage.click_rows),
    spend: spend.startsWith("unknown") ? spend : `${spend} ${coverage.currency}`,
  };
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
