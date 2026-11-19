import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../../lib/supabase";
import { ProductionAttemptComparison } from "../../components/ProductionAttemptComparison";

type RoutePackage = { id: string; route: string; version: number };
type Work = {
  id: string;
  route_package_id: string | null;
  item_key: string;
  state: string;
  blocker: string | null;
  effective_state?: string;
  effective_blocker?: string | null;
  qa_state: string;
  expected_output: { media_type?: string; content_format?: string; platform?: string };
};
type Binding = { work_item_id: string; run_id: string; piece_key: string };
type Step = { id: string; run_id: string; step_key: string; status: string; blocker: string | null };
type ProductionCounts = {
  demand_id: string; attempts: number; produced: number; rejected: number; revised: number;
  workflow_accepted: number; human_approved: number;
};

type Piece = {
  work: Work;
  route: string;
  version: number;
  steps: Step[];
  counts: ProductionCounts | null;
};

const controlClass = "rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50";

/** Current route-package progress. Workflow QA is internal; review remains human. */
export function CampaignSweepWork({ clientId, campaignId, route }: {
  clientId: string; campaignId: string; route?: "paid" | "organic";
}) {
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState<string | null>(null);
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++request.current;
    const fail = (message: string) => {
      if (version === request.current) { setError(message); setLoading(false); }
    };
    const packageResult = await supabase.from("campaign_route_packages_v6")
      .select("id, route, version").eq("client_id", clientId)
      .eq("campaign_id", campaignId).order("version", { ascending: false });
    if (version !== request.current) return;
    if (packageResult.error) return fail(packageResult.error.message);
    const latest = new Map<string, RoutePackage>();
    for (const row of (packageResult.data ?? []) as RoutePackage[]) {
      if ((row.route === "organic" || row.route === "paid")
        && typeof row.id === "string" && !latest.has(row.route)) latest.set(row.route, row);
    }
    const packageIds = [...latest.values()].map((row) => row.id);
    if (!packageIds.length) {
      setPieces([]); setError(null); setLoading(false); return;
    }
    const workResult = await supabase.from("delivery_work_effective_v6")
      .select("id, route_package_id, item_key, state, blocker, effective_state, effective_blocker, qa_state, expected_output")
      .eq("client_id", clientId).eq("campaign_id", campaignId)
      .eq("owner_module", "content_production_factory")
      .in("route_package_id", packageIds);
    if (version !== request.current) return;
    if (workResult.error) return fail(workResult.error.message);
    const work = (workResult.data ?? []) as Work[];
    if (!work.length) {
      setPieces([]); setError(null); setLoading(false); return;
    }
    const countsResult = await supabase.from("production_demand_counts_v8")
      .select("demand_id, attempts, produced, rejected, revised, workflow_accepted, human_approved")
      .eq("client_id", clientId).eq("demand_kind", "campaign")
      .in("demand_id", work.map((row) => row.id));
    if (version !== request.current) return;
    if (countsResult.error) return fail(countsResult.error.message);
    const countsByWork = new Map(((countsResult.data ?? []) as ProductionCounts[])
      .map((row) => [row.demand_id, row]));
    const bindingResult = await supabase.from("campaign_sweep_work_bindings_v7")
      .select("work_item_id, run_id, piece_key")
      .in("work_item_id", work.map((row) => row.id));
    if (version !== request.current) return;
    if (bindingResult.error) return fail(bindingResult.error.message);
    const bindings = (bindingResult.data ?? []) as Binding[];
    const runIds = [...new Set(bindings.map((row) => row.run_id))];
    const stepsResult = runIds.length ? await supabase.from("workflow_steps")
      .select("id, run_id, step_key, status, blocker").in("run_id", runIds)
      : null;
    if (version !== request.current) return;
    if (stepsResult?.error) return fail(stepsResult.error.message);
    const steps = (stepsResult?.data ?? []) as Step[];
    const packageById = new Map([...latest.values()].map((row) => [row.id, row]));
    const bindingByWork = new Map(bindings.map((row) => [row.work_item_id, row]));
    setPieces(work.map((row) => {
      const routePackage = packageById.get(row.route_package_id ?? "");
      const binding = bindingByWork.get(row.id);
      return {
        work: row,
        route: routePackage?.route ?? "unknown",
        version: routePackage?.version ?? 0,
        steps: binding ? steps.filter((step) => step.run_id === binding.run_id
          && step.step_key.startsWith(`${binding.piece_key}_`)) : [],
        counts: countsByWork.get(row.id) ?? null,
      };
    }).sort((a, b) => Number(a.work.item_key.match(/\d+$/)?.[0] ?? 0)
      - Number(b.work.item_key.match(/\d+$/)?.[0] ?? 0)));
    setError(null);
    setLoading(false);
  }, [clientId, campaignId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 15_000);
    return () => { window.clearInterval(timer); request.current++; };
  }, [refresh]);

  const retry = async (step: Step) => {
    setRetrying(step.id);
    setError(null);
    setNotice(null);
    const { error: retryError } = await supabase.rpc("retry_campaign_sweep_step_v7", {
      p_step_id: step.id,
    });
    setRetrying(null);
    if (retryError) { setError(retryError.message); return; }
    setNotice(`Retry requested for ${step.step_key.replaceAll("_", " ")}.`);
    void refresh();
  };

  const visiblePieces = route ? pieces.filter((piece) => piece.route === route) : pieces;

  return <section className="mt-4 rounded-lg border border-border bg-card p-4" aria-label="Campaign production work">
    <div className="flex items-center justify-between gap-2">
      <h3 className="font-semibold">Campaign production work</h3>
      <button type="button" className={controlClass} onClick={() => void refresh()}>Refresh work</button>
    </div>
    {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    {notice && <p role="status" className="mt-2 text-xs">{notice}</p>}
    {loading && <p className="mt-2 text-xs text-muted-foreground">Loading work…</p>}
    {!loading && !error && !visiblePieces.length && <p className="mt-2 text-xs text-muted-foreground">No production pieces have been swept into the current route packages.</p>}
    {visiblePieces.length > 0 && <ol className="mt-3 space-y-3">{visiblePieces.map(({ work, route, version, steps, counts }) => {
      const blocked = steps.filter((step) => step.status === "blocked" || step.status === "failed");
      const shownState = work.effective_state ?? work.state;
      return <li key={work.id} className="rounded-md border border-border p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-medium">{work.item_key.replaceAll("_", " ")} · {route} v{version}</p>
          <span className="text-xs">{shownState.replaceAll("_", " ")}</span>
        </div>
        <p className="mt-1 break-all text-xs text-muted-foreground">Request ID: <code>{work.id}</code></p>
        <p className="mt-1 text-xs text-muted-foreground">
          {[work.expected_output.platform, work.expected_output.media_type,
            work.expected_output.content_format].filter(Boolean).join(" · ")}
          {steps.length ? ` · ${steps.filter((step) => step.status === "completed").length}/${steps.length} steps complete` : ""}
        </p>
        {counts && <p className="mt-1 text-xs text-muted-foreground">
          1 requested · {counts.produced} produced · {counts.rejected} failed or rejected attempts · {counts.revised} revised · {counts.workflow_accepted} passed workflow QA · {counts.human_approved} human approved
        </p>}
        {counts && <ProductionAttemptComparison clientId={clientId}
          demandId={work.id} count={counts.attempts} />}
        {shownState === "ready_for_review" && <p className="mt-2 text-xs">Internal QA passed. Review the exact asset before distribution.</p>}
        {(work.effective_blocker ?? work.blocker) && <p className="mt-2 text-xs text-destructive">{work.effective_blocker ?? work.blocker}</p>}
        {blocked.map((step) => <div key={step.id} className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span>{step.step_key.replaceAll("_", " ")}: {step.blocker ?? step.status}</span>
          <button type="button" className={controlClass}
            disabled={retrying !== null || work.state !== "held"}
            onClick={() => void retry(step)}>Retry this step</button>
        </div>)}
      </li>;
    })}</ol>}
  </section>;
}
