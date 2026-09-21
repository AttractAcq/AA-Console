import { useCallback, useEffect, useState } from "react";
import { CHAIN_STAGES } from "../../lib/contentChain";
import type { ArchiveRow, ChainStage } from "../../lib/contentChain";
import { supabase } from "../../lib/supabase";
import { cn } from "../../lib/cn";
import { shortDate } from "../../lib/media";

/**
 * One archived chain, stage by stage.
 *
 * Six tabs because a piece of content passes through six places and the
 * question the archive answers is "what happened to this" — which is not
 * answerable from any one of them. The reference is the title of the whole
 * thing; each tab reads the records that stage actually wrote.
 *
 * Loaded per tab rather than all at once. Most visits want one stage, and
 * six queries to answer a question about one of them is five wasted.
 */
export function ChainDetailModal({
  row,
  open,
  onClose,
}: {
  row: ArchiveRow | null;
  open: boolean;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<ChainStage>("ideation");
  const [data, setData] = useState<Record<string, unknown>[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Back to the first stage on every open: a modal that remembers the last
  // chain's tab shows you stage four of something you have not looked at.
  useEffect(() => {
    if (open) setStage("ideation");
  }, [open, row?.brief_ref]);

  const load = useCallback(async () => {
    if (!row) return;
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const rows = await loadStage(stage, row);
      setData(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load that stage.");
    }
    setLoading(false);
  }, [stage, row]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  if (!open || !row) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-foreground/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="chain-title"
        className="relative flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lg"
      >
        <header className="shrink-0 border-b border-border px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 id="chain-title" className="text-base font-semibold text-card-foreground">
                <span className="font-mono text-sm text-muted-foreground">{row.brief_ref}</span>
                {" · "}
                {row.title}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Archived {shortDate(row.archived_at)}
                {row.pillar_name ? ` · ${row.pillar_name}` : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Close
            </button>
          </div>

          <div role="tablist" aria-label="Chain stages" className="mt-3 flex flex-wrap gap-1">
            {CHAIN_STAGES.map((s) => (
              <button
                key={s.id}
                role="tab"
                type="button"
                aria-selected={stage === s.id}
                onClick={() => setStage(s.id)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  stage === s.id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {!loading && !error && (data?.length ?? 0) === 0 && (
            <p className="text-sm text-muted-foreground">{emptyFor(stage)}</p>
          )}
          {!loading && !error && data && data.length > 0 && (
            <dl className="space-y-4">
              {data.map((record, i) => (
                <div key={i} className="rounded-md border border-border p-3">
                  {Object.entries(record).map(([key, value]) =>
                    value === null || value === "" ? null : (
                      <div key={key} className="flex gap-3 py-0.5 text-sm">
                        <dt className="w-40 shrink-0 text-muted-foreground">{key}</dt>
                        <dd className="min-w-0 whitespace-pre-wrap break-words text-card-foreground">
                          {render(value)}
                        </dd>
                      </div>
                    ),
                  )}
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
    </div>
  );
}

function render(value: unknown): string {
  if (Array.isArray(value)) return value.map((v, i) => `${i + 1}. ${String(v)}`).join("\n");
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

/** What an empty stage means, which is never the same thing twice. */
function emptyFor(stage: ChainStage): string {
  switch (stage) {
    case "ideation":
      return "No idea behind this brief — it was written directly.";
    case "asset":
      return "Nothing was ever built from this brief.";
    case "distribution":
      return "This was never scheduled.";
    case "reporting":
      return "Nothing published, so there is nothing to report against.";
    case "iteration":
      return "Built once and never rebuilt.";
    default:
      return "Nothing recorded at this stage.";
  }
}

async function loadStage(stage: ChainStage, row: ArchiveRow): Promise<Record<string, unknown>[]> {
  if (stage === "ideation") {
    if (!row.idea_id) return [];
    const { data, error } = await supabase
      .from("client_ideas")
      .select("title, body, media_type, content_format, source, source_question, strategic_reason, content_territory, status, created_at, archived_at")
      .eq("id", row.idea_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? [data as Record<string, unknown>] : [];
  }

  if (stage === "brief") {
    const { data, error } = await supabase
      .from("client_briefs")
      .select("brief_ref, title, media_type, content_format, frame_count, frame_plan, status, hook, premise, argument, proof, script, visual_direction, call_to_action, channel_intent, created_at, archived_at")
      .eq("id", row.brief_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? [data as Record<string, unknown>] : [];
  }

  if (stage === "asset") {
    const { data, error } = await supabase
      .from("client_media_assets")
      .select("ref_number, title, media_type, content_format, review_status, human_approved_at, created_at")
      .eq("brief_id", row.brief_id)
      .order("created_at");
    if (error) throw new Error(error.message);
    return (data ?? []) as Record<string, unknown>[];
  }

  if (stage === "distribution") {
    const { data: assets, error: assetError } = await supabase
      .from("client_media_assets")
      .select("id")
      .eq("brief_id", row.brief_id);
    if (assetError) throw new Error(assetError.message);
    const ids = (assets ?? []).map((a) => (a as { id: string }).id);
    if (ids.length === 0) return [];
    const { data, error } = await supabase
      .from("scheduled_posts")
      .select("ref_number, scheduled_for, channel, platform, publication_status, published_at, failure_reason")
      .in("asset_id", ids)
      .order("scheduled_for");
    if (error) throw new Error(error.message);
    return (data ?? []) as Record<string, unknown>[];
  }

  if (stage === "reporting") {
    // content_attribution is already keyed on brief_ref, which is the whole
    // reason the archive is too.
    const { data, error } = await supabase
      .from("content_attribution")
      .select("asset_ref, posts, channels, first_published, impressions, reach, clicks, spend, leads, conversations, appointments, sales, opportunity_value, sale_value, cash_collected")
      .eq("brief_ref", row.brief_ref);
    if (error) throw new Error(error.message);
    return (data ?? []) as Record<string, unknown>[];
  }

  // Iteration: every rebuild carries an account of what was wrong with the
  // one before it. That account IS the iteration record — there is no
  // separate table, and inventing one would duplicate what is already here.
  const { data, error } = await supabase
    .from("creative_generations")
    .select("created_at, stage, quality, size, remake_feedback, cost_usd")
    .eq("brief_id", row.brief_id)
    .not("remake_feedback", "is", null)
    .order("created_at");
  if (error) throw new Error(error.message);
  return (data ?? []) as Record<string, unknown>[];
}
