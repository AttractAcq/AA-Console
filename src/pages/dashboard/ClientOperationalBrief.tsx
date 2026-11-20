import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { Panel } from "../../components/Panel";
import { supabase } from "../../lib/supabase";

type Brief = {
  capturedAt: string;
  staleApprovals: number | null;
  pendingApprovals: number | null;
  heldApprovals: number | null;
  heldApprovalItems: { id: string; title: string; owning_path: string | null; preview_blocker: string | null }[] | null;
  heldActionCount: number | null;
  heldActions: { action_key: string; blocker: string }[] | null;
  failedActions: number | null;
  executedActions: number | null;
  owedDeliveries: number | null;
  integrations: { provider: string; status: string; last_checked_at: string | null }[] | null;
  lastExternalOutcome: { source_kind: string; outcome: string; occurred_at: string; owning_path: string; external_ref: string | null } | null | undefined;
  externalProblems: number | null;
  measurement: { leads: number; sales: number; sourcedLeads: number; consentedLeads: number; latestMetaRead: string | null; latestGoogleRead: string | null } | null;
  linkedAsset: { title: string; leads: number; sales: number } | null | undefined;
  errors: string[];
};

/** A source-backed brief. Each failed read remains unknown rather than zero. */
export function ClientOperationalBrief({ clientId, spend, failedRuns, activeRuns }: {
  clientId: string;
  spend: number | null;
  failedRuns: number | null;
  activeRuns: number | null;
}) {
  const [brief, setBrief] = useState<Brief | null>(null);
  const refresh = useCallback(async () => {
    const [pending, stale, sourceHeld, sourceHeldItems, held, failed, executed, actions, deliveries, integrations, lastOutcome, externalProblems, funnel, coverage, linkedAssets] = await Promise.all([
      supabase.from("approval_inbox_v6").select("id", { count: "exact", head: true }).eq("client_id", clientId).eq("status", "pending"),
      supabase.from("approval_inbox_v6").select("id", { count: "exact", head: true }).eq("client_id", clientId).eq("status", "stale"),
      supabase.from("approval_inbox_v6").select("id", { count: "exact", head: true }).eq("client_id", clientId).eq("status", "source_held"),
      supabase.from("approval_inbox_v6").select("id,title,owning_path,preview_blocker").eq("client_id", clientId).eq("status", "source_held").order("requested_at", { ascending: false }).limit(3),
      supabase.from("campaign_action_due").select("approval_id", { count: "exact", head: true }).eq("client_id", clientId).neq("execution_status", "executed").not("blocker", "is", null),
      supabase.from("campaign_action_due").select("approval_id", { count: "exact", head: true }).eq("client_id", clientId).in("execution_status", ["failed", "abandoned", "uncertain"]),
      supabase.from("campaign_action_due").select("approval_id", { count: "exact", head: true }).eq("client_id", clientId).eq("execution_status", "executed"),
      supabase.from("campaign_action_due").select("action_key,blocker,execution_status").eq("client_id", clientId).neq("execution_status", "executed").not("blocker", "is", null).limit(3),
      supabase.from("lead_magnet_deliveries").select("id", { count: "exact", head: true }).eq("client_id", clientId).in("status", ["queued", "sending", "failed", "uncertain"]),
      supabase.from("client_integrations").select("provider,status,last_checked_at").eq("client_id", clientId),
      supabase.rpc("list_client_external_outcomes_v6", { p_client_id: clientId }).select("source_kind,outcome,occurred_at,owning_path,external_ref").in("outcome", ["confirmed", "executed"]).order("occurred_at", { ascending: false }).limit(1),
      supabase.rpc("list_client_external_outcomes_v6", { p_client_id: clientId }, { count: "exact", head: true }).select("outcome_id").in("outcome", ["refused", "uncertain", "different", "pending", "rejected", "unverified", "unattributed", "failed", "abandoned"]),
      supabase.rpc("acquisition_funnel", { p_client_id: clientId, p_days: 30 }),
      supabase.rpc("acquisition_coverage_v8", { p_client_id: clientId, p_days: 30 }),
      supabase.rpc("top_content_by_revenue", { p_client_id: clientId, p_limit: 10 }),
    ]);
    const errors = [pending.error, stale.error, sourceHeld.error, sourceHeldItems.error, held.error, failed.error, executed.error, actions.error, deliveries.error, integrations.error, lastOutcome.error, externalProblems.error, funnel.error, coverage.error, linkedAssets.error]
      .filter((error): error is NonNullable<typeof error> => Boolean(error))
      .map((error) => error.message);
    const actionRows = actions.error ? null : actions.data ?? [];
    const receipt = lastOutcome.data?.[0];
    const lastExternalOutcome = receipt?.source_kind && receipt.outcome && receipt.occurred_at && receipt.owning_path
      ? { source_kind: receipt.source_kind, outcome: receipt.outcome,
          occurred_at: receipt.occurred_at, owning_path: receipt.owning_path,
          external_ref: receipt.external_ref }
      : null;
    const recordedFunnel = funnel.data?.[0];
    const recordedCoverage = coverage.data?.[0];
    const topLinkedAsset = linkedAssets.data?.find((row) => row.leads > 0);
    setBrief({
      capturedAt: new Date().toISOString(),
      staleApprovals: stale.error ? null : stale.count,
      pendingApprovals: pending.error ? null : pending.count,
      heldApprovals: sourceHeld.error ? null : sourceHeld.count,
      heldApprovalItems: sourceHeldItems.error ? null : (sourceHeldItems.data ?? [])
        .filter((item): item is typeof item & { id: string; title: string } => Boolean(item.id && item.title)),
      heldActionCount: held.error ? null : held.count,
      heldActions: actionRows?.map((row) => ({ action_key: row.action_key ?? "unknown",
        blocker: row.blocker ?? "Unknown blocker." })) ?? null,
      failedActions: failed.error ? null : failed.count,
      executedActions: executed.error ? null : executed.count,
      owedDeliveries: deliveries.error ? null : deliveries.count,
      integrations: integrations.error ? null : integrations.data ?? [],
      lastExternalOutcome: lastOutcome.error ? undefined : lastExternalOutcome,
      externalProblems: externalProblems.error ? null : externalProblems.count,
      measurement: funnel.error || coverage.error || !recordedFunnel || !recordedCoverage ? null : {
        leads: recordedFunnel.leads,
        sales: recordedFunnel.sales,
        sourcedLeads: recordedCoverage.sourced_leads,
        consentedLeads: recordedCoverage.consented_leads,
        latestMetaRead: recordedCoverage.latest_meta_read_at,
        latestGoogleRead: recordedCoverage.latest_google_read_at,
      },
      linkedAsset: linkedAssets.error ? undefined : topLinkedAsset
        ? { title: topLinkedAsset.asset_title ?? topLinkedAsset.asset_ref ?? "Untitled asset",
            leads: topLinkedAsset.leads, sales: topLinkedAsset.sales }
        : null,
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
        <div><dt className="text-muted-foreground">Agent work</dt><dd>{count(activeRuns)} active · {count(failedRuns)} unresolved failures</dd></div>
        <div><dt className="text-muted-foreground">Agent spend</dt><dd>{spend == null ? "unknown" : `$${spend.toFixed(2)} recorded`}</dd></div>
        <div><dt className="text-muted-foreground">Approvals</dt><dd>{count(brief?.pendingApprovals)} pending · {count(brief?.heldApprovals)} source held · {count(brief?.staleApprovals)} stale <Link className="text-primary underline" to={`${base}/delivery/approval-inbox?tab=unified`}>Open inbox</Link></dd></div>
        <div><dt className="text-muted-foreground">Campaign actions</dt><dd>{count(brief?.heldActionCount)} held · {count(brief?.failedActions)} failed or uncertain · {count(brief?.executedActions)} executed <Link className="text-primary underline" to={`${base}/delivery/approval-inbox?tab=campaign-actions`}>View outcomes</Link></dd></div>
        <div><dt className="text-muted-foreground">Lead magnet deliveries owed</dt><dd>{count(brief?.owedDeliveries)} <Link className="text-primary underline" to={`${base}/delivery/lead-magnet-studio`}>Open studio</Link></dd></div>
        <div><dt className="text-muted-foreground">Provider records</dt><dd>{count(brief?.integrations?.length)} recorded <Link className="text-primary underline" to={`${base}/account/integrations`}>Review access</Link></dd></div>
        <div><dt className="text-muted-foreground">External execution</dt><dd>
          {count(brief?.externalProblems)} requiring reconciliation · latest receipt: {brief?.lastExternalOutcome === undefined ? "unknown" : brief.lastExternalOutcome === null ? "none recorded" : (
            <Link className="text-primary underline" to={brief.lastExternalOutcome.owning_path.startsWith(`${base}/`) ? brief.lastExternalOutcome.owning_path : `${base}/delivery/approval-inbox?tab=unified`}>
              {brief.lastExternalOutcome.source_kind.replaceAll("_", " ")} · {new Date(brief.lastExternalOutcome.occurred_at).toLocaleString()}
            </Link>
          )}
        </dd></div>
        <div><dt className="text-muted-foreground">Recorded acquisition · 30 days</dt><dd>
          {brief?.measurement ? `${brief.measurement.leads} leads · ${brief.measurement.sales} sales; ${brief.measurement.sourcedLeads}/${brief.measurement.leads} leads with source; ${brief.measurement.consentedLeads}/${brief.measurement.leads} with recorded consent` : "unknown"}
          {" "}<Link className="text-primary underline" to={`${base}/delivery/attribution-os`}>Inspect journeys</Link>
        </dd></div>
        <div><dt className="text-muted-foreground">Latest paid account inventory read</dt><dd>
          {brief?.measurement ? `Meta: ${brief.measurement.latestMetaRead ? new Date(brief.measurement.latestMetaRead).toLocaleString() : "unknown"} · Google: ${brief.measurement.latestGoogleRead ? new Date(brief.measurement.latestGoogleRead).toLocaleString() : "unknown"}` : "unknown"}
        </dd></div>
        <div><dt className="text-muted-foreground">Content with recorded lead links · all time</dt><dd>
          {brief?.linkedAsset === undefined ? "unknown" : brief.linkedAsset === null ? "none recorded" : `${brief.linkedAsset.title}: ${brief.linkedAsset.leads} linked leads, ${brief.linkedAsset.sales} recorded sales`}
          {" "}<Link className="text-primary underline" to={`${base}/delivery/attribution-os`}>Review evidence</Link>
        </dd></div>
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">Lead links are recorded associations, with limited confidence until source and provider coverage are verified. They do not prove that content caused a sale.</p>
      {brief?.heldApprovalItems && brief.heldApprovalItems.length > 0 && (
        <div className="mt-3 text-xs text-muted-foreground">
          <p className="font-semibold">Approvals needing source attention</p>
          <ul className="mt-1 space-y-1">
            {brief.heldApprovalItems.map((item) => <li key={item.id}>
              <Link className="text-primary underline" to={item.owning_path?.startsWith(`${base}/`) ? item.owning_path : `${base}/delivery/approval-inbox?tab=unified`}>{item.title}</Link>
              {item.preview_blocker ? ` · ${item.preview_blocker}` : " · source held; open the owning queue for details"}
            </li>)}
          </ul>
        </div>
      )}
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
