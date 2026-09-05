import { useCallback, useEffect, useState } from "react";
import { Panel } from "../../components/Panel";
import { DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { MonthCalendar } from "../../components/MonthCalendar";
import type { ScheduledAsset } from "../../components/MonthCalendar";
import { supabase } from "../../lib/supabase";
import { cn } from "../../lib/cn";

/**
 * The client-facing read-only views.
 *
 * Everything here already exists in tables the client can read under their
 * own RLS — these are windows onto it, not new machinery. They are written
 * for someone who is paying for the work rather than doing it, so they lead
 * with what is happening and what it costs, not with internal status.
 */

export function ActiveCampaignsView({ clientId }: { clientId: string }) {
  const [rows, setRows] = useState<
    Array<{
      id: string;
      campaign_ref: string;
      target_role: string;
      daily_spend: number;
      total_spend: number;
      objective_achieved: string | null;
      status: string;
      started_on: string;
    }>
  >([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const { data } = await supabase
      .from("campaigns")
      .select(
        "id, campaign_ref, target_role, daily_spend, total_spend, objective_achieved, status, started_on",
      )
      .eq("client_id", clientId)
      .order("started_on", { ascending: false });
    setRows((data ?? []) as typeof rows);
    setLoading(false);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) return <p className="text-sm text-muted-foreground">Loading campaigns…</p>;

  const active = rows.filter((r) => r.status === "active");
  const past = rows.filter((r) => r.status !== "active");
  const dailySpend = active.reduce((sum, r) => sum + Number(r.daily_spend), 0);
  const totalSpend = rows.reduce((sum, r) => sum + Number(r.total_spend), 0);

  const money = (v: number) => v.toFixed(2);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Panel title="Active campaigns">
          <p className="text-2xl font-semibold text-card-foreground">{active.length}</p>
        </Panel>
        <Panel title="Current daily spend">
          <p className="text-2xl font-semibold text-card-foreground">{money(dailySpend)}</p>
        </Panel>
        <Panel title="Total spend to date">
          <p className="text-2xl font-semibold text-card-foreground">{money(totalSpend)}</p>
        </Panel>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-foreground">Running now</h2>
        <DataTable
          columns={["Campaign", "Target", "Daily spend", "Total spend", "Objective achieved"]}
          emptyLabel="Nothing is running at the moment"
          rows={active.map((r) => [
            r.campaign_ref,
            r.target_role,
            money(Number(r.daily_spend)),
            money(Number(r.total_spend)),
            r.objective_achieved ?? "In progress",
          ])}
        />
      </div>

      {past.length > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-semibold text-foreground">Finished</h2>
          <DataTable
            columns={["Campaign", "Target", "Total spend", "Objective achieved"]}
            emptyLabel=""
            rows={past.map((r) => [
              r.campaign_ref,
              r.target_role,
              money(Number(r.total_spend)),
              r.objective_achieved ?? "—",
            ])}
          />
        </div>
      )}
    </div>
  );
}

export function ActiveOrganicView({ clientId }: { clientId: string }) {
  const [posts, setPosts] = useState<
    Array<{
      id: string;
      scheduled_for: string;
      ref_number: string | null;
      media_type: string;
      published_at: string | null;
    }>
  >([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const { data } = await supabase
      .from("scheduled_posts")
      .select("id, scheduled_for, ref_number, media_type, published_at")
      .eq("client_id", clientId)
      .eq("channel", "organic")
      .order("scheduled_for");
    setPosts((data ?? []) as typeof posts);
    setLoading(false);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) return <p className="text-sm text-muted-foreground">Loading schedule…</p>;

  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const upcoming = posts.filter((p) => p.scheduled_for >= today);
  const published = posts.filter((p) => p.published_at !== null);

  const calendar: ScheduledAsset[] = posts
    .filter((p) => p.scheduled_for.startsWith(month))
    .map((p) => ({ day: Number(p.scheduled_for.slice(8, 10)), refNumber: p.ref_number ?? "—" }));

  if (posts.length === 0) {
    return <EmptyState label="Nothing scheduled yet — posts appear here once they are approved and booked in" />;
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Panel title="Scheduled">
          <p className="text-2xl font-semibold text-card-foreground">{posts.length}</p>
        </Panel>
        <Panel title="Still to come">
          <p className="text-2xl font-semibold text-card-foreground">{upcoming.length}</p>
        </Panel>
        <Panel title="Published">
          <p className="text-2xl font-semibold text-card-foreground">{published.length}</p>
        </Panel>
      </div>

      <MonthCalendar assets={calendar} />

      <div>
        <h2 className="mb-3 text-sm font-semibold text-foreground">Coming up</h2>
        <DataTable
          columns={["Date", "Reference", "Type", "Status"]}
          emptyLabel="Nothing upcoming"
          rows={upcoming.map((p) => [
            p.scheduled_for,
            p.ref_number ?? "—",
            p.media_type,
            p.published_at ? "Published" : "Scheduled",
          ])}
        />
      </div>
    </div>
  );
}

export function ActiveConversionView({ clientId }: { clientId: string }) {
  const [pages, setPages] = useState<
    Array<{
      id: string;
      title: string;
      page_type: string;
      status: string;
      published_url: string | null;
      body: string | null;
    }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { data } = await supabase
      .from("client_pages")
      .select("id, title, page_type, status, published_url, body")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false });
    setPages((data ?? []) as typeof pages);
    setLoading(false);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) return <p className="text-sm text-muted-foreground">Loading pages…</p>;
  if (pages.length === 0) {
    return <EmptyState label="No pages built yet — landing and offer pages appear here as they are made" />;
  }

  const live = pages.filter((p) => p.published_url);
  const open = pages.find((p) => p.id === openId);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Panel title="Pages built">
          <p className="text-2xl font-semibold text-card-foreground">{pages.length}</p>
        </Panel>
        <Panel title="Live">
          <p className="text-2xl font-semibold text-card-foreground">{live.length}</p>
        </Panel>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {pages.map((p) => (
          <div key={p.id} className="flex flex-col rounded-lg border border-border bg-card p-5">
            <p className="text-sm font-semibold text-card-foreground">{p.title}</p>
            <p className="mt-1 text-xs capitalize text-muted-foreground">
              {p.page_type} page · {p.status}
            </p>
            {p.published_url ? (
              <a
                href={p.published_url}
                target="_blank"
                rel="noreferrer"
                className="mt-2 truncate rounded text-sm text-brand-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {p.published_url}
              </a>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">Not published yet</p>
            )}
            {p.body && (
              <button
                type="button"
                onClick={() => setOpenId(p.id)}
                className="mt-auto pt-3 text-left text-sm font-medium text-brand-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Read the page
              </button>
            )}
          </div>
        ))}
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close"
            className="absolute inset-0 bg-foreground/40"
            onClick={() => setOpenId(null)}
          />
          <div
            role="dialog"
            aria-modal="true"
            className={cn(
              "relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden",
              "rounded-lg border border-border bg-card shadow-lg",
            )}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold text-card-foreground">{open.title}</h2>
              <button
                type="button"
                onClick={() => setOpenId(null)}
                className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Close
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{open.body}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
