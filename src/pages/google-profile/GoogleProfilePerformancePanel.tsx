import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

type Run = Database["public"]["Views"]["google_profile_performance_current_v8"]["Row"];
type Point = Database["public"]["Tables"]["google_profile_performance_points_v8"]["Row"];
type Location = Pick<Database["public"]["Tables"]["client_google_locations"]["Row"],
  "id" | "title" | "location_ref" | "verification_state">;

const METRICS = [
  ["BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "Maps desktop impressions"],
  ["BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", "Search desktop impressions"],
  ["BUSINESS_IMPRESSIONS_MOBILE_MAPS", "Maps mobile impressions"],
  ["BUSINESS_IMPRESSIONS_MOBILE_SEARCH", "Search mobile impressions"],
  ["BUSINESS_DIRECTION_REQUESTS", "Direction requests"],
  ["CALL_CLICKS", "Call clicks"],
  ["WEBSITE_CLICKS", "Website clicks"],
] as const;

export function GoogleProfilePerformancePanel({ clientId, locations }: {
  clientId: string | undefined; locations: Location[];
}) {
  return <ClientPerformancePanel key={clientId ?? "no-client"}
    clientId={clientId} locations={locations} />;
}

function ClientPerformancePanel({ clientId, locations }: {
  clientId: string | undefined; locations: Location[];
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [points, setPoints] = useState<Point[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) { setLoading(false); return; }
    setLoading(true);
    try {
      const read = await supabase.from("google_profile_performance_current_v8")
        .select("*").eq("client_id", clientId);
      if (read.error) throw read.error;
      const current = read.data ?? [];
      const ids = current.map((row) => row.id).filter((id): id is string => id !== null);
      const detail = ids.length ? await supabase.from("google_profile_performance_points_v8")
        .select("*").eq("client_id", clientId).in("run_id", ids)
        : { data: [] as Point[], error: null };
      if (detail.error) throw detail.error;
      setRuns(current);
      setPoints(detail.data ?? []);
      setError(null);
    } catch (cause) {
      setRuns([]); setPoints([]);
      setError(cause instanceof Error ? cause.message : "Profile performance read unavailable.");
    } finally { setLoading(false); }
  }, [clientId]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function queue(locationId: string) {
    if (!clientId || busy) return;
    setBusy(locationId); setError(null); setNotice(null);
    try {
      const result = await supabase.rpc("request_google_profile_performance_read_v8", {
        p_location_id: locationId,
      });
      if (result.error) throw result.error;
      setNotice("Read-only Business Profile performance job queued. Refresh after it completes.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not queue the profile read.");
    } finally { setBusy(null); }
  }

  return <div className="space-y-4">
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-brand-strong">{notice}</p>}
    {locations.length === 0 && <p className="text-sm text-muted-foreground">
      No Business Profile location is recorded. Profile metrics are unknown.
    </p>}
    {locations.map((location) => {
      const run = runs.find((row) => row.location_id === location.id);
      const windowDays = run?.from_date && run.through_date
        ? (Date.parse(`${run.through_date}T00:00:00Z`)
          - Date.parse(`${run.from_date}T00:00:00Z`)) / 86_400_000 + 1 : 0;
      return <section key={location.id} className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="font-semibold">{location.title}</h4>
            <p className="text-xs text-muted-foreground">{location.location_ref}</p>
          </div>
          <div className="flex gap-2">
            <Button disabled={busy !== null || location.verification_state !== "verified"
              || !/^accounts\/[A-Za-z0-9_-]+\/locations\/[0-9]+$/.test(location.location_ref)}
              onClick={() => void queue(location.id)}>Read profile metrics</Button>
            <Button disabled={busy !== null} onClick={() => void refresh()}>Refresh view</Button>
          </div>
        </div>
        {loading ? <p className="text-sm">Loading metrics…</p>
          : !run ? <p className="text-sm text-muted-foreground">
            No current-location and credential-bound performance read is recorded. Metrics are unknown.
          </p>
            : <>
              <p className="text-xs text-muted-foreground">
                Google read {run.fetched_at ? new Date(run.fetched_at).toLocaleString() : "time unknown"}
                {" · "}requested period {run.from_date ?? "unknown"} to {run.through_date ?? "unknown"}.
                This is a dated snapshot, not a live counter.
              </p>
              <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {METRICS.map(([metric, label]) => {
                  const rows = points.filter((point) => point.run_id === run.id && point.metric === metric);
                  const observed = (run.observed_metrics ?? []).includes(metric);
                  const sum = rows.reduce((total, point) => total + BigInt(point.value), 0n);
                  return <div key={metric} className="rounded border border-border p-3">
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="font-semibold">{observed && rows.length ? sum.toLocaleString() : "Unknown"}</dd>
                    <p className="text-xs text-muted-foreground">
                      {observed && rows.length
                        ? `${rows.length}/${windowDays} dated values returned${rows.length === windowDays ? "" : "; other dates unknown"}`
                        : "No dated values returned"}
                    </p>
                  </div>;
                })}
              </dl>
            </>}
      </section>;
    })}
  </div>;
}
