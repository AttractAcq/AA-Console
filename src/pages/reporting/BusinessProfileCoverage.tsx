import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../lib/supabase";

type Coverage = { locations: number; currentReads: number; latestRead: string | null };

/** A Business Profile read is separate from a Google Ads account read. */
export function BusinessProfileCoverage({ clientId }: { clientId: string | undefined }) {
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unknown">(
    clientId ? "loading" : "unknown");

  useEffect(() => {
    let current = true;
    if (!clientId) return () => { current = false; };
    void (async () => {
      try {
        const [locations, reads] = await Promise.all([
          supabase.from("client_google_locations").select("id").eq("client_id", clientId),
          supabase.from("google_profile_performance_current_v8")
            .select("location_id,fetched_at").eq("client_id", clientId),
        ]);
        if (locations.error || reads.error) throw new Error("Profile coverage read failed");
        const ids = new Set((locations.data ?? []).map((row) => row.id));
        const currentReads = (reads.data ?? []).filter((row) =>
          row.location_id !== null && ids.has(row.location_id));
        const latestRead = currentReads.reduce<string | null>((latest, row) =>
          row.fetched_at && (!latest || row.fetched_at > latest) ? row.fetched_at : latest, null);
        if (current) {
          setCoverage({ locations: ids.size, currentReads: currentReads.length, latestRead });
          setState("ready");
        }
      } catch {
        if (current) { setCoverage(null); setState("unknown"); }
      }
    })();
    return () => { current = false; };
  }, [clientId]);

  return <p>
    Business Profile performance: {state === "loading" ? "checking coverage…"
      : state === "unknown" ? "coverage unknown; the current profile read could not be verified."
        : coverage?.locations === 0 ? "no location recorded; metrics unknown."
          : `${coverage?.currentReads ?? 0} of ${coverage?.locations ?? 0} recorded locations have a current-bound read; latest ${coverage?.latestRead ? new Date(coverage.latestRead).toLocaleString() : "unknown"}. Missing locations and dates remain unknown.`}
    {clientId && <> <Link className="underline" to={`/clients/${clientId}/google-profile?tab=metrics`}>Open Google Studio metrics</Link>.</>}
  </p>;
}
