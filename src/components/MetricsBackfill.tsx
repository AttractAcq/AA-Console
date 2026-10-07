import { useCallback, useEffect, useMemo, useState } from "react";

import { supabase } from "../lib/supabase";
import { cn } from "../lib/cn";
import {
  PRESETS,
  coverageSentence,
  windowDays,
  windowProblem,
  type CoverageRow,
  type Surface,
  type Window,
} from "../lib/backfill";

/**
 * Ask for a window of metrics history.
 *
 * `enqueue_metrics_ingest_jobs` has taken a window since it was written and
 * nothing ever passed it one, so the only history this system has pulled is
 * the trailing seven days. The panel above this has told people for weeks
 * that they "can still run a pull by hand". This is that.
 *
 * Coverage first, then the window. A date picker over a guess is how a
 * person re-pulls a month that is already complete and pays for it: these
 * are real requests against the client's own API quota.
 */

type Pull = {
  job_id: string;
  surface: string | null;
  since: string | null;
  until: string | null;
  asked_for_by_hand: boolean;
  status: string;
  error: string | null;
};

const SURFACES: ReadonlyArray<{ value: Surface; label: string }> = [
  { value: "both", label: "Both" },
  { value: "paid", label: "Paid only" },
  { value: "organic", label: "Organic only" },
];

const IN_FLIGHT = new Set(["queued", "paused", "claimed", "running"]);

export function MetricsBackfill({ clientId }: { clientId: string }) {
  const [coverage, setCoverage] = useState<CoverageRow[]>([]);
  const [pulls, setPulls] = useState<Pull[]>([]);
  // Read rather than assumed. A cap the UI believes is 400 while the
  // database enforces 90 is migration 156 again with a worse message.
  const [maxDays, setMaxDays] = useState<number | null>(null);
  const [surface, setSurface] = useState<Surface>("both");
  const [window, setWindow] = useState<Window>(() => PRESETS[1]!.window());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [cov, pull, cap] = await Promise.all([
      supabase
        .from("metrics_coverage")
        .select("surface, first_day, last_day, days_with_data, days_missing_inside, last_fetched_at")
        .eq("client_id", clientId),
      supabase
        .from("metrics_pulls")
        .select("job_id, surface, since, until, asked_for_by_hand, status, error")
        .eq("client_id", clientId)
        .limit(10),
      supabase.rpc("max_backfill_days"),
    ]);
    setCoverage((cov.data ?? []) as CoverageRow[]);
    setPulls((pull.data ?? []) as Pull[]);
    const limit = Number(cap.data);
    setMaxDays(Number.isFinite(limit) && limit > 0 ? limit : null);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const problem = useMemo(() => windowProblem(window, maxDays), [window, maxDays]);
  const bySurface = useMemo(
    () => new Map(coverage.map((row) => [row.surface, row])),
    [coverage],
  );
  const running = pulls.filter((p) => IN_FLIGHT.has(p.status));

  async function request() {
    setBusy(true);
    setError(null);
    setNote(null);
    const { data, error: failure } = await supabase.rpc("request_metrics_backfill", {
      p_client_id: clientId,
      p_since: window.since,
      p_until: window.until,
      p_surface: surface === "both" ? null : surface,
    });
    setBusy(false);
    if (failure) {
      setError(failure.message);
      return;
    }
    const queued = Array.isArray(data) ? data.length : data ? 1 : 0;
    setNote(
      `Queued ${queued} pull${queued === 1 ? "" : "s"} for ${window.since} to ${window.until}. ` +
        "These run against the client's own API quota, so they take as long as they take.",
    );
    await refresh();
  }

  return (
    <section className="mt-6 space-y-4 rounded-lg border border-border p-4">
      <div>
        <h3 className="text-sm font-medium text-card-foreground">Pull history</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          The daily sync only ever fetches the last 7 days, so anything from before this client was
          connected is missing until it is asked for. Each pull is a real request against the
          client&rsquo;s own API quota.
        </p>
      </div>

      <div className="space-y-1">
        {(["paid", "organic"] as const).map((s) => (
          <p key={s} className="text-xs">
            <span className="font-medium capitalize text-foreground">{s}:</span>{" "}
            <span className="text-muted-foreground">{coverageSentence(bySurface.get(s), s)}</span>
          </p>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((preset) => {
            const w = preset.window();
            const active = w.since === window.since && w.until === window.until;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => setWindow(w)}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "border-primary bg-primary/10 text-brand-strong"
                    : "border-border text-muted-foreground hover:bg-accent",
                )}
              >
                {preset.label}
              </button>
            );
          })}
        </div>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          From
          <input
            type="date"
            value={window.since}
            onChange={(e) => setWindow((w) => ({ ...w, since: e.target.value }))}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          To
          <input
            type="date"
            value={window.until}
            onChange={(e) => setWindow((w) => ({ ...w, until: e.target.value }))}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Surface
          <select
            value={surface}
            onChange={(e) => setSurface(e.target.value as Surface)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {SURFACES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          disabled={busy || problem !== null}
          onClick={() => void request()}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Pull {windowDays(window)} day{windowDays(window) === 1 ? "" : "s"}
        </button>
      </div>

      {problem && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}

      {running.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-foreground">Being pulled now</p>
          <ul className="space-y-0.5">
            {running.map((p) => (
              <li key={p.job_id} className="text-xs text-muted-foreground">
                {p.surface} · {p.since} to {p.until} · {p.status}
                {p.asked_for_by_hand ? " · asked for by hand" : " · daily sync"}
                {p.status === "paused" && p.error ? ` · held: ${p.error}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
