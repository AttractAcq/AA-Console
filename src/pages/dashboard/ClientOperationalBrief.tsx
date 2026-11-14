import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { Panel } from "../../components/Panel";
import { supabase } from "../../lib/supabase";

type Brief = {
  capturedAt: string;
  staleApprovals: number | null;
  pendingApprovals: number | null;
  heldActionCount: number | null;
  heldActions: { action_key: string; blocker: string }[] | null;
  failedActions: number | null;
  executedActions: number | null;
  owedDeliveries: number | null;
  integrations: { provider: string; status: string; last_checked_at: string | null }[] | null;
  errors: string[];
};

/** A source-backed brief. Each failed read remains unknown rather than zero. */
export function ClientOperationalBrief({ clientId, spend, failedRuns, activeRuns }: {
  clientId: string;
  spend: number;
  failedRuns: number;
  activeRuns: number;
}) {
  const [brief, setBrief] = useState<Brief | null>(null);
  const refresh = useCallback(async () => {
    const [pending, stale, held, failed, executed, actions, deliveries, integrations] = await Promise.all([
      supabase.from("approval_inbox_v6").select("id", { count: "exact", head: true }).eq("client_id", clientId).eq("status", "pending"),
      supabase.from("approval_inbox_v6").select("id", { count: "exact", head: true }).eq("client_id", clientId).eq("status", "stale"),
      supabase.from("campaign_action_due").select("approval_id", { count: "exact", head: true }).eq("client_id", clientId).neq("execution_status", "executed"),
      supabase.from("campaign_action_due").select("approval_id", { count: "exact", head: true }).eq("client_id", clientId).in("execution_status", ["failed", "abandoned"]),
      supabase.from("campaign_action_due").select("approval_id", { count: "exact", head: true }).eq("client_id", clientId).eq("execution_status", "executed"),
      supabase.from("campaign_action_due").select("action_key,blocker,execution_status").eq("client_id", clientId).neq("execution_status", "executed").limit(3),
      supabase.from("lead_magnet_deliveries").select("id", { count: "exact", head: true }).eq("client_id", clientId).in("status", ["queued", "sending", "failed"]),
      supabase.from("client_integrations").select("provider,status,last_checked_at").eq("client_id", clientId),
    ]);
    const errors = [pending.error, stale.error, held.error, failed.error, executed.error, actions.error, deliveries.error, integrations.error]
      .filter((error): error is NonNullable<typeof error> => Boolean(error))
      .map((error) => error.message);
    const actionRows = actions.error ? null : actions.data ?? [];
    setBrief({
      capturedAt: new Date().toISOString(),
      staleApprovals: stale.error ? null : stale.count,
      pendingApprovals: pending.error ? null : pending.count,
      heldActionCount: held.error ? null : held.count,
      heldActions: actionRows?.filter((row) => row.execution_status !== "executed")
        .map((row) => ({ action_key: row.action_key,
          blocker: row.blocker ?? "Generic campaign-action claims are held in the runtime before execution." })) ?? null,
      failedActions: failed.error ? null : failed.count,
      executedActions: executed.error ? null : executed.count,
      owedDeliveries: deliveries.error ? null : deliveries.count,
      integrations: integrations.error ? null : integrations.data ?? [],
      errors,
    });
  }, [clientId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const base = `/clients/${clientId}`;
  const count = (value: number | null | undefined) => value == null ? "unknown" : String(value);
  return (
    <Panel title="Master AI · operational brief">
      <p className="text-xs text-muted-foreground">
        Read-only source summary{brief ? ` · refreshed ${new Date(brief.capturedAt).toLocaleString()}` : " · loading"}.
        Provider status below is recorded metadata, not a live account or rights check.
      </p>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div><dt className="text-muted-foreground">Agent work</dt><dd>{activeRuns} active · {failedRuns} unresolved failures</dd></div>
        <div><dt className="text-muted-foreground">Agent spend</dt><dd>${spend.toFixed(2)} recorded</dd></div>
        <div><dt className="text-muted-foreground">Approvals</dt><dd>{count(brief?.pendingApprovals)} pending · {count(brief?.staleApprovals)} stale <Link className="text-primary underline" to={`${base}/delivery/approval-inbox?tab=unified`}>Open inbox</Link></dd></div>
        <div><dt className="text-muted-foreground">Campaign actions</dt><dd>{count(brief?.heldActionCount)} held · {count(brief?.failedActions)} failed · {count(brief?.executedActions)} executed <Link className="text-primary underline" to={`${base}/delivery/approval-inbox?tab=campaign-actions`}>View outcomes</Link></dd></div>
        <div><dt className="text-muted-foreground">Lead magnet deliveries owed</dt><dd>{count(brief?.owedDeliveries)} <Link className="text-primary underline" to={`${base}/delivery/lead-magnet-studio`}>Open studio</Link></dd></div>
        <div><dt className="text-muted-foreground">Provider records</dt><dd>{count(brief?.integrations?.length)} recorded <Link className="text-primary underline" to={`${base}/account/integrations`}>Review access</Link></dd></div>
      </dl>
      {brief?.heldActions && brief.heldActions.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          {brief.heldActions.slice(0, 3).map((action, index) => <li key={`${action.action_key}-${index}`}>{action.action_key.replaceAll("_", " ")}: {action.blocker}</li>)}
        </ul>
      )}
      {brief?.integrations && brief.integrations.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2 text-xs">
          {brief.integrations.map((provider) => <li key={provider.provider} className="rounded-md bg-muted px-2 py-1">
            {provider.provider}: {provider.status}{provider.last_checked_at ? ` · checked ${new Date(provider.last_checked_at).toLocaleDateString()}` : " · no check recorded"}
          </li>)}
        </ul>
      )}
      {brief?.errors && brief.errors.length > 0 && <p role="alert" className="mt-3 text-xs text-destructive">Some source reads failed; affected counts are unknown. {brief.errors.join(" ")}</p>}
    </Panel>
  );
}
