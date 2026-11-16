import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../../lib/supabase";

type Draft = {
  run_id: string;
  page_work_item_id: string | null;
  sales_work_item_id: string | null;
};
type Work = { id: string; item_key: string; state: string; blocker: string | null;
  effective_state?: string; effective_blocker?: string | null };
type Step = { id: string; step_key: string; status: string; blocker: string | null };

const controlClass = "rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50";

/** Plan-bound conversion drafts stop at human review, before any public use. */
export function CampaignConversionWork({ clientId, campaignId, needsPage, needsAgent, needsMagnet = false }: {
  clientId: string; campaignId: string; needsPage: boolean; needsAgent: boolean; needsMagnet?: boolean;
}) {
  const [work, setWork] = useState<Work[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++request.current;
    const fail = (message: string) => {
      if (version === request.current) { setError(message); setLoading(false); }
    };
    const [draftResult, magnetResult] = await Promise.all([
      supabase.from("campaign_conversion_drafts_v7")
        .select("run_id, page_work_item_id, sales_work_item_id")
        .eq("client_id", clientId).eq("campaign_id", campaignId)
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("campaign_magnet_drafts_v7")
        .select("run_id, work_item_id")
        .eq("client_id", clientId).eq("campaign_id", campaignId)
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (version !== request.current) return;
    if (draftResult.error || magnetResult.error)
      return fail(draftResult.error?.message ?? magnetResult.error?.message ?? "Campaign work could not be read.");
    const draft = draftResult.data as Draft | null;
    const magnet = magnetResult.data as { run_id: string; work_item_id: string } | null;
    const magnetId = magnet && magnet.run_id === draft?.run_id ? magnet.work_item_id : null;
    const ids = [draft?.page_work_item_id, draft?.sales_work_item_id, magnetId]
      .filter((id): id is string => typeof id === "string");
    if (!draft || !ids.length) {
      setWork([]); setSteps([]); setError(null); setLoading(false); return;
    }
    const [workResult, stepResult] = await Promise.all([
      supabase.from("delivery_work_effective_v6")
        .select("id, item_key, state, blocker, effective_state, effective_blocker")
        .eq("client_id", clientId).in("id", ids),
      supabase.from("workflow_steps")
        .select("id, step_key, status, blocker").eq("run_id", draft.run_id)
        .in("step_key", ["conversion_page", "conversion_sales_agent", "conversion_lead_magnet"]),
    ]);
    if (version !== request.current) return;
    if (workResult.error || stepResult.error)
      return fail(workResult.error?.message ?? stepResult.error?.message ?? "Conversion work could not be read.");
    setWork((workResult.data ?? []) as Work[]);
    setSteps((stepResult.data ?? []) as Step[]);
    setError(null);
    setLoading(false);
  }, [clientId, campaignId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 15_000);
    return () => { window.clearInterval(timer); request.current++; };
  }, [refresh]);

  const retry = async (step: Step) => {
    setRetrying(true); setNotice(null); setError(null);
    const { error: retryError } = await supabase.rpc(step.step_key === "conversion_lead_magnet"
      ? "retry_campaign_magnet_step_v7" : "retry_campaign_conversion_step_v7",
      { p_step_id: step.id });
    setRetrying(false);
    if (retryError) { setError(retryError.message); return; }
    setNotice(`Retry requested for ${step.step_key === "conversion_page" ? "campaign page"
      : step.step_key === "conversion_lead_magnet" ? "lead magnet" : "sales agent"}.`);
    void refresh();
  };

  const ordered = ["campaign_page", "campaign_sales_agent", "campaign_lead_magnet"];
  return <section className="mt-4 rounded-lg border border-border bg-card p-4" aria-label="Campaign conversion work">
    <div className="flex items-center justify-between gap-2">
      <h3 className="font-semibold">Campaign conversion work</h3>
      <button type="button" className={controlClass} onClick={() => void refresh()}>Refresh work</button>
    </div>
    {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    {notice && <p role="status" className="mt-2 text-xs">{notice}</p>}
    {loading && <p className="mt-2 text-xs text-muted-foreground">Loading conversion work…</p>}
    {!loading && !error && !work.length && <p className="mt-2 text-xs text-muted-foreground">
      No plan-bound conversion drafts have been swept yet. Required: {[needsPage && "page", needsAgent && "sales agent", needsMagnet && "lead magnet"].filter(Boolean).join(" and ")}.
    </p>}
    {work.length > 0 && <ol className="mt-3 space-y-3">{[...work]
      .sort((a, b) => ordered.indexOf(a.item_key) - ordered.indexOf(b.item_key))
      .map((item) => {
        const label = item.item_key === "campaign_page" ? "Campaign page"
          : item.item_key === "campaign_lead_magnet" ? "Lead magnet" : "Sales agent";
        const step = steps.find((candidate) => candidate.step_key ===
          (item.item_key === "campaign_page" ? "conversion_page"
            : item.item_key === "campaign_lead_magnet" ? "conversion_lead_magnet" : "conversion_sales_agent"));
        const blocked = step?.status === "blocked" || step?.status === "failed";
        const shownState = item.effective_state ?? item.state;
        return <li key={item.id} className="rounded-md border border-border p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium">{label}</p>
            <span className="text-xs">{shownState.replaceAll("_", " ")}</span>
          </div>
          {step && <p className="mt-1 text-xs text-muted-foreground">Producer: {step.status.replaceAll("_", " ")}</p>}
          {shownState === "ready_for_review" && <p className="mt-2 text-xs">Internal QA passed. Review the exact draft before public use.</p>}
          {(item.effective_blocker ?? item.blocker) && <p className="mt-2 text-xs text-destructive">{item.effective_blocker ?? item.blocker}</p>}
          {blocked && step && <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span>{step.blocker ?? "Producer blocked"}</span>
            <button type="button" className={controlClass}
              disabled={retrying || item.state !== "held"}
              onClick={() => void retry(step)}>Retry this step</button>
          </div>}
        </li>;
      })}</ol>}
  </section>;
}
