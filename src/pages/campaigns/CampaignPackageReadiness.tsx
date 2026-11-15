import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";

type Readiness = {
  status: "unsupported" | "preparing" | "ready_for_review";
  run_id?: string | null;
  expected?: number;
  ready?: number;
  blockers: string[];
};

export function CampaignPackageReadiness({ campaignId }: { campaignId: string }) {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const { data, error: readError } = await supabase.rpc("campaign_package_readiness_v7",
      { p_campaign_id: campaignId });
    if (readError) { setError(readError.message); return; }
    setReadiness(data as Readiness);
    setError(null);
  }, [campaignId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return <section className="mt-4 rounded-lg border border-border bg-card p-4" aria-label="Campaign package readiness">
    <div className="flex items-center justify-between gap-2">
      <h3 className="font-semibold">Production package readiness</h3>
      <button type="button" className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent"
        onClick={() => void refresh()}>Refresh readiness</button>
    </div>
    {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    {!error && !readiness && <p className="mt-2 text-xs text-muted-foreground">Checking exact sweep outputs…</p>}
    {readiness && <>
      <p className="mt-2 text-sm">{readiness.status === "ready_for_review"
        ? "All required outputs passed internal QA and are ready for package review."
        : readiness.status === "unsupported" ? "This legacy campaign has no route package."
          : `${readiness.ready ?? 0} of ${readiness.expected ?? 0} required outputs ready for review.`}</p>
      {readiness.run_id && <p className="mt-1 text-xs text-muted-foreground">Sweep {readiness.run_id}</p>}
      {readiness.status === "ready_for_review" && <p className="mt-2 text-xs text-muted-foreground">
        Internal QA does not approve publication, paid activation, page publishing, or public agent enablement.
      </p>}
      {readiness.blockers.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-destructive">
        {readiness.blockers.map((blocker, index) => <li key={`${index}-${blocker}`}>{blocker}</li>)}
      </ul>}
    </>}
  </section>;
}
