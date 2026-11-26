import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";
import {
  EXECUTION_HINT,
  fetchCampaignActionDue,
  fetchCampaignActionsEnabled,
  type CampaignActionDue,
} from "../../lib/campaignActions";

type Approval = Database["public"]["Tables"]["campaign_action_approvals"]["Row"];
type PageSnapshot = Database["public"]["Tables"]["campaign_page_approval_snapshots"]["Row"];
type ActionAttempt = {
  execution_id: string; attempt_number: number; status: string;
  started_at: string; finished_at: string | null; external_id: string | null;
  external_url: string | null; error: string | null; legacy_inferred: boolean;
};
type ActionRevocation = { approval_id: string; reason: string; revoked_at: string };
type BudgetReadback = { execution_id: string; result: string; observed_currency: string;
  observed_daily_budget_minor: number; checked_at: string; account_id: string };
type BudgetJob = { input_id: string; status: string };
type PageReadback = { execution_id: string; result: string; checked_ref: string;
  observed_sha256: string | null; checked_at: string; repository_owner: string;
  repository_name: string; site_path: string };
type ProofReleaseObservation = { execution_id: string; placement_ref: string | null;
  expected_payload_hash: string | null; placement_approval_status: string | null;
  placement_status: string | null; payload_matches: boolean | null;
  destination_key: string | null; external_id: string | null; external_url: string | null;
  retracted_at: string | null };
type LeadEnrollmentSource = { execution_id: string; sequence_name: string | null;
  started_at: string | null; finished_at: string | null; observed_count: number | null;
  skipped_count: number | null; current_observation_rows: number };
type ProofRetractionDemand = { approval_id: string; placement_id: string;
  destination_key: string; placement_status: string; demand_status: string;
  external_url: string | null; external_id: string | null; reason: string };

export function CampaignActionApprovalsPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [requests, setRequests] = useState<Approval[]>([]);
  const [pageSnapshots, setPageSnapshots] = useState<Record<string, PageSnapshot>>({});
  const [decided, setDecided] = useState<CampaignActionDue[]>([]);
  const [attemptsByExecution, setAttemptsByExecution] = useState<Record<string, ActionAttempt[]> | null>({});
  const [revocations, setRevocations] = useState<Record<string, ActionRevocation>>({});
  const [budgetReadbacks, setBudgetReadbacks] = useState<Record<string, BudgetReadback>>({});
  const [budgetJobs, setBudgetJobs] = useState<Record<string, BudgetJob>>({});
  const [pageReadbacks, setPageReadbacks] = useState<Record<string, PageReadback>>({});
  const [pageJobs, setPageJobs] = useState<Record<string, BudgetJob>>({});
  const [proofObservations, setProofObservations] = useState<Record<string, ProofReleaseObservation[]>>({});
  const [leadSources, setLeadSources] = useState<Record<string, LeadEnrollmentSource>>({});
  const [proofRetractions, setProofRetractions] = useState<Record<string, ProofRetractionDemand[]>>({});
  const [actionsOn, setActionsOn] = useState(false);
  const [runtimeHold, setRuntimeHold] = useState<string | null>("Runtime state has not been verified.");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reasonById, setReasonById] = useState<Record<string, string>>({});
  const [revokeReasonById, setRevokeReasonById] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const failedCount = decided.filter((action) =>
    ["failed", "abandoned", "uncertain"].includes(action.execution_status)).length;
  const heldCount = decided.filter((action) =>
    !revocations[action.approval_id] && action.execution_status === "not_attempted"
      && Boolean(action.blocker || runtimeHold)).length;

  const refresh = useCallback(async () => {
    if (!clientId) {
      setRequests([]);
      setPageSnapshots({});
      setDecided([]);
      setAttemptsByExecution({});
      setRevocations({});
      setBudgetReadbacks({});
      setBudgetJobs({});
      setPageReadbacks({});
      setPageJobs({});
      setProofObservations({});
      setLeadSources({});
      setProofRetractions({});
      setLoading(false);
      return;
    }
    setLoading(true);
    // What happened after the last yes. Read before the pending list so that
    // a failure reading it cannot leave the outcomes of previous decisions
    // looking like an empty list, which reads as "nothing has happened".
    try {
      const [due, on, runtime] = await Promise.all([
        fetchCampaignActionDue(clientId),
        fetchCampaignActionsEnabled(clientId),
        supabase.rpc("client_runtime_controls_v6" as never, { p_client_id: clientId } as never),
      ]);
      setDecided(due);
      if (due.length > 0) {
        const [{ data: revokedRows, error: revokedError }, retractionRows] = await Promise.all([
          supabase.from("campaign_action_revocations_v6")
            .select("approval_id,reason,revoked_at")
            .in("approval_id", due.map((action) => action.approval_id)),
          supabase.from("campaign_proof_retraction_status_v6" as never)
            .select("approval_id,placement_id,destination_key,placement_status,demand_status,external_url,external_id,reason")
            .in("approval_id", due.map((action) => action.approval_id)),
        ]);
        if (revokedError) throw new Error(`Action revocations could not be read: ${revokedError.message}`);
        if (retractionRows.error) throw new Error(`Proof retraction demands could not be read: ${retractionRows.error.message}`);
        setRevocations(Object.fromEntries(((revokedRows ?? []) as ActionRevocation[])
          .map((row) => [row.approval_id, row])));
        const groupedRetractions: Record<string, ProofRetractionDemand[]> = {};
        for (const row of (retractionRows.data ?? []) as ProofRetractionDemand[]) {
          (groupedRetractions[row.approval_id] ??= []).push(row);
        }
        setProofRetractions(groupedRetractions);
      } else {
        setRevocations({});
        setProofRetractions({});
      }
      setActionsOn(on);
      const control = runtime.data as { state?: string; reason?: string; workerEnabled?: boolean;
        controls?: { campaignActions?: boolean }; holds?: { campaignActions?: string } } | null;
      setRuntimeHold(runtime.error?.message ?? (control?.state !== "observed"
        ? control?.reason ?? "Runtime state has not been verified."
        : control.workerEnabled !== true || control.controls?.campaignActions !== true
          ? "Campaign action runtime switch is off or unreported."
          : control.holds?.campaignActions ?? null));
      const executionIds = due.map((action) => action.execution_id).filter((id): id is string => Boolean(id));
      if (executionIds.length === 0) {
        setAttemptsByExecution({});
        setBudgetReadbacks({});
        setBudgetJobs({});
        setPageReadbacks({});
        setPageJobs({});
        setProofObservations({});
        setLeadSources({});
      } else {
        const [{ data: attemptRows, error: attemptError }, readbacks, jobs, pageChecks, pageJobRows, proofRows, leadRows] = await Promise.all([
          supabase.from("campaign_action_attempts_v6" as never)
            .select("execution_id,attempt_number,status,started_at,finished_at,external_id,external_url,error,legacy_inferred")
            .in("execution_id", executionIds).order("attempt_number", { ascending: true }),
          supabase.rpc("list_campaign_budget_readback_overview_v6", { p_client_id: clientId })
            .select("execution_id,result,observed_currency,observed_daily_budget_minor,checked_at,account_id")
            .in("execution_id", executionIds).order("checked_at", { ascending: false }),
          supabase.from("agent_jobs").select("input_id,status")
            .eq("agent_key", "campaign_budget_reconciler").in("input_id", executionIds)
            .order("created_at", { ascending: false }),
          supabase.rpc("list_campaign_page_readback_overview_v6", { p_client_id: clientId })
            .select("execution_id,result,checked_ref,observed_sha256,checked_at,repository_owner,repository_name,site_path")
            .in("execution_id", executionIds).order("checked_at", { ascending: false }),
          supabase.from("agent_jobs").select("input_id,status")
            .eq("agent_key", "campaign_page_reconciler").in("input_id", executionIds)
            .order("created_at", { ascending: false }),
          supabase.from("campaign_proof_release_observations_v6" as never)
            .select("execution_id,placement_ref,expected_payload_hash,placement_approval_status,placement_status,payload_matches,destination_key,external_id,external_url,retracted_at")
            .in("execution_id", executionIds),
          supabase.from("campaign_lead_enrolment_source_v6" as never)
            .select("execution_id,sequence_name,started_at,finished_at,observed_count,skipped_count,current_observation_rows")
            .in("execution_id", executionIds),
        ]);
        if (attemptError) throw new Error(`Attempt receipts could not be read: ${attemptError.message}`);
        if (readbacks.error) throw new Error(`Budget readbacks could not be read: ${readbacks.error.message}`);
        if (jobs.error) throw new Error(`Budget readback jobs could not be read: ${jobs.error.message}`);
        if (pageChecks.error) throw new Error(`Page readbacks could not be read: ${pageChecks.error.message}`);
        if (pageJobRows.error) throw new Error(`Page readback jobs could not be read: ${pageJobRows.error.message}`);
        if (proofRows.error) throw new Error(`Proof release observations could not be read: ${proofRows.error.message}`);
        if (leadRows.error) throw new Error(`Lead enrolment source could not be read: ${leadRows.error.message}`);
        const grouped: Record<string, ActionAttempt[]> = {};
        for (const row of (attemptRows ?? []) as ActionAttempt[]) {
          (grouped[row.execution_id] ??= []).push(row);
        }
        setAttemptsByExecution(grouped);
        const latest: Record<string, BudgetReadback> = {};
        for (const row of (readbacks.data ?? []) as BudgetReadback[]) {
          latest[row.execution_id] ??= row;
        }
        setBudgetReadbacks(latest);
        const latestJobs: Record<string, BudgetJob> = {};
        for (const row of (jobs.data ?? []) as BudgetJob[]) {
          if (row.input_id) latestJobs[row.input_id] ??= row;
        }
        setBudgetJobs(latestJobs);
        const latestPage: Record<string, PageReadback> = {};
        for (const row of (pageChecks.data ?? []) as PageReadback[]) {
          latestPage[row.execution_id] ??= row;
        }
        setPageReadbacks(latestPage);
        const latestPageJobs: Record<string, BudgetJob> = {};
        for (const row of (pageJobRows.data ?? []) as BudgetJob[]) {
          if (row.input_id) latestPageJobs[row.input_id] ??= row;
        }
        setPageJobs(latestPageJobs);
        const groupedProof: Record<string, ProofReleaseObservation[]> = {};
        for (const row of (proofRows.data ?? []) as ProofReleaseObservation[]) {
          (groupedProof[row.execution_id] ??= []).push(row);
        }
        setProofObservations(groupedProof);
        setLeadSources(Object.fromEntries(((leadRows.data ?? []) as LeadEnrollmentSource[])
          .map((row) => [row.execution_id,row])));
      }
    } catch (cause) {
      setAttemptsByExecution(null);
      setBudgetReadbacks({});
      setBudgetJobs({});
      setPageReadbacks({});
      setPageJobs({});
      setProofObservations({});
      setLeadSources({});
      setProofRetractions({});
      setRuntimeHold("Runtime state has not been verified.");
      setError(cause instanceof Error ? cause.message : "Could not read what happened to approved actions.");
    }
    const { data, error: queryError } = await supabase
      .from("campaign_action_approvals")
      .select("*")
      .eq("client_id", clientId)
      .eq("status", "pending")
      .order("requested_at", { ascending: true });
    setLoading(false);
    if (queryError) {
      setError(queryError.message);
      return;
    }
    const pageIds = (data ?? []).filter((request) => request.action_key === "page_deploy")
      .map((request) => request.id);
    if (pageIds.length > 0) {
      const { data: snapshots, error: snapshotError } = await supabase
        .from("campaign_page_approval_snapshots")
        .select("*")
        .in("approval_id", pageIds);
      if (snapshotError) {
        setError(snapshotError.message);
        setPageSnapshots({});
        setRequests(data ?? []);
        return;
      }
      setPageSnapshots(Object.fromEntries((snapshots ?? []).map((row) => [row.approval_id, row])));
    } else {
      setPageSnapshots({});
    }
    setError(null);
    setRequests(data ?? []);
  }, [clientId]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function decide(request: Approval, decision: "approved" | "rejected") {
    if (decision === "approved" && request.action_key === "page_deploy" && !pageSnapshots[request.id]) {
      setError("This page request has no reviewable version snapshot. Ask for a new request.");
      return;
    }
    const reason = reasonById[request.id]?.trim();
    if (decision === "rejected" && !reason) {
      setError("Enter a reason before rejecting this request.");
      return;
    }
    setBusyId(request.id);
    setError(null);
    const { error: rpcError } = await supabase.rpc("decide_campaign_action_approval_v6", {
      p_request_id: request.id,
      p_decision: decision,
      // p_reason defaults to null in SQL, so an approval leaves the key out
      // rather than passing one. The generated type says optional, not
      // nullable, and those are the same thing to the function.
      ...(decision === "rejected" ? { p_reason: reason } : {}),
    });
    setBusyId(null);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    await refresh();
  }

  async function revoke(approvalId: string) {
    const reason = revokeReasonById[approvalId]?.trim();
    if (!reason) {
      setError("Enter a reason before revoking an approved action.");
      return;
    }
    setBusyId(approvalId);
    setError(null);
    const { error: rpcError } = await supabase.rpc("revoke_campaign_action_approval_v6", {
      p_approval_id: approvalId, p_reason: reason,
    });
    setBusyId(null);
    if (rpcError) { setError(rpcError.message); return; }
    await refresh();
  }

  async function requestBudgetReadback(executionId: string) {
    setBusyId(executionId);
    setError(null);
    const { error: rpcError } = await supabase.rpc("request_campaign_budget_readback_v6", {
      p_execution_id: executionId,
    });
    setBusyId(null);
    if (rpcError) { setError(rpcError.message); return; }
    await refresh();
  }

  async function requestPageReadback(executionId: string) {
    setBusyId(executionId);
    setError(null);
    const { error: rpcError } = await supabase.rpc("request_campaign_page_readback_v6", {
      p_execution_id: executionId,
    });
    setBusyId(null);
    if (rpcError) { setError(rpcError.message); return; }
    await refresh();
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold">Campaign action requests</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Each decision covers one campaign package version, destination, action and scope.
          Approval records the decision; it does not perform the action. Execution receipts
          appear below only after an action actually runs.
        </p>
      </div>

      <p role="status" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        {runtimeHold
          ? `Campaign action execution is held: ${runtimeHold} An approval alone does not release this hold.`
          : "The owned campaign action worker is observed and attested. Each action still requires exact approval and last-moment checks."}
      </p>
      {!loading && (failedCount > 0 || heldCount > 0) && (
        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <p className="font-medium">Campaign action owner attention</p>
          <p className="mt-1">
            {failedCount} failed, stopped or uncertain action{failedCount === 1 ? "" : "s"}; {heldCount} approved action{heldCount === 1 ? "" : "s"} held before an attempt.
          </p>
          <a href="#campaign-action-outcomes" className="mt-2 inline-block text-primary underline">Review blockers and attempt receipts</a>
        </div>
      )}

      {/* Decisions remain here; the one client control lives on Dashboard. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
        <div>
          <p className="text-sm font-medium">
            External campaign actions are {actionsOn ? "on" : "off"} for this client
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {actionsOn
              ? runtimeHold
                ? "This client switch is on, but execution is held. Each action still needs its own exact-version approval."
                : "The owned worker may claim exact approved actions after its last-moment checks."
              : "Approvals are recorded while the client switch is off."}
          </p>
        </div>
        <Link to={`/clients/${clientId}/delivery/switches`} className="text-sm text-primary underline">View switches</Link>
      </div>
      {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
      {loading ? <p className="text-sm text-muted-foreground">Loading requests…</p>
        : requests.length === 0 ? <p className="text-sm text-muted-foreground">No campaign action requests are waiting.</p>
          : <div className="space-y-4">{requests.map((request) => (
            <article key={request.id} className="rounded-xl border border-border bg-card p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold">{request.action_key.replaceAll("_", " ")}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">Destination: {request.destination}</p>
                </div>
                <Link className="text-sm text-primary underline" to={`/clients/${clientId}/delivery/campaign-factory/${request.campaign_id}`}>
                  View campaign
                </Link>
              </div>
              <dl className="mt-4 grid gap-2 text-xs sm:grid-cols-2">
                <div><dt className="text-muted-foreground">Package ID</dt><dd className="break-all font-mono">{request.manifest_id}</dd></div>
                <div><dt className="text-muted-foreground">Artifact version hash</dt><dd className="break-all font-mono">{request.artifact_version_hash}</dd></div>
              </dl>
              <p className="mt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">Approved scope</p>
              <pre className="mt-1 max-h-56 overflow-auto rounded-lg bg-muted p-3 text-xs">{JSON.stringify(request.scope, null, 2)}</pre>
              {request.action_key === "page_deploy" && (pageSnapshots[request.id] ? (
                <div className="mt-4 space-y-2">
                  <p className="text-sm font-medium">Page revision preview</p>
                  <p className="text-xs text-muted-foreground">
                    Review the page destined for {request.destination}. Scripts and forms are disabled in this preview.
                  </p>
                  <iframe
                    title={`Page revision for ${request.destination}`}
                    sandbox=""
                    referrerPolicy="no-referrer"
                    srcDoc={pageSnapshots[request.id].rendered_html}
                    className="h-80 w-full rounded-lg border border-border bg-white"
                  />
                  <details className="text-xs"><summary className="cursor-pointer">View exact HTML source</summary>
                    <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-muted p-3">{pageSnapshots[request.id].rendered_html}</pre>
                  </details>
                </div>
              ) : <p role="alert" className="mt-4 text-sm text-destructive">
                No reviewable page snapshot is attached. Request a new approval.
              </p>)}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button type="button" disabled={busyId === request.id || (request.action_key === "page_deploy" && !pageSnapshots[request.id])}
                  onClick={() => void decide(request, "approved")}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
                  Approve this scope
                </button>
                <input aria-label={`Reason to reject ${request.action_key}`} value={reasonById[request.id] ?? ""}
                  onChange={(event) => setReasonById((prior) => ({ ...prior, [request.id]: event.target.value }))}
                  placeholder="Reason to reject" className="min-w-48 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                <button type="button" disabled={busyId === request.id}
                  onClick={() => void decide(request, "rejected")}
                  className="rounded-lg border border-border px-4 py-2 text-sm font-medium disabled:opacity-50">
                  Reject
                </button>
              </div>
            </article>
          ))}</div>}

      {/* Everything already approved, and what became of it. An approval
          whose outcome nobody can see is the same problem as no approval:
          somebody clicks yes and then has to guess. */}
      <section id="campaign-action-outcomes" className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">After the decision</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Approved actions, and why each has or has not been performed. The database due view
            does not include this runtime's current hold state.
          </p>
        </div>
        {decided.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing has been approved yet.</p>
        ) : (
          <div className="space-y-3">
            {decided.map((action) => (
              <article key={action.approval_id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold">{action.action_key.replaceAll("_", " ")}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {action.destination} · Executor module: {action.executor_module.replaceAll("_", " ")}
                    </p>
                    {revocations[action.approval_id] && <p className="mt-1 text-xs text-destructive">
                      Revoked: {revocations[action.approval_id].reason}. No further execution is authorized.
                      {action.execution_status === "executed" && " Any external effect already recorded remains live until separately retracted."}
                    </p>}
                  </div>
                  <Link
                    className="text-xs text-primary underline"
                    to={`/clients/${clientId}/delivery/campaign-factory/${action.campaign_id}`}
                  >
                    View campaign
                  </Link>
                </div>
                <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">State</dt>
                    <dd>
                      {action.execution_status.replaceAll("_", " ")}
                      {action.attempts > 0 && ` · ${action.attempts} attempt${action.attempts === 1 ? "" : "s"}`}
                      <span className="block text-muted-foreground">
                        {EXECUTION_HINT[action.execution_status] ?? ""}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Why not, if not</dt>
                    <dd className={action.blocker ? "text-destructive" : "text-brand-strong"}>
                      {action.blocker ?? runtimeHold ?? "Database due; waiting for the next owned-worker sweep."}
                    </dd>
                  </div>
                  {action.external_id && (
                    <div>
                      <dt className="text-muted-foreground">External record</dt>
                      <dd className="break-all font-mono">
                        {action.external_url ? (
                          <a href={action.external_url} target="_blank" rel="noreferrer" className="underline">
                            {action.external_id}
                          </a>
                        ) : (
                          action.external_id
                        )}
                      </dd>
                    </div>
                  )}
                  {action.last_error && (
                    <div>
                      <dt className="text-muted-foreground">Last error</dt>
                      <dd className="text-destructive">{action.last_error}</dd>
                    </div>
                  )}
                </dl>
                {action.action_key === "budget_change" && action.execution_status === "uncertain" && action.execution_id && (
                  <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
                    <p className="font-medium">Read-only Meta budget check</p>
                    <p className="mt-1">The check reads the ad set once and records its current amount. A matching amount does not prove this action changed it; no budget write is retried.</p>
                    {budgetReadbacks[action.execution_id] && <p className="mt-2">
                      Latest observation: {budgetReadbacks[action.execution_id].result.replaceAll("_", " ")}
                      {` · ${budgetReadbacks[action.execution_id].observed_daily_budget_minor / 100} ${budgetReadbacks[action.execution_id].observed_currency}`}
                      {` · ${new Date(budgetReadbacks[action.execution_id].checked_at).toLocaleString()}`}
                    </p>}
                    {budgetJobs[action.execution_id] && <p className="mt-1">Latest readback job: {budgetJobs[action.execution_id].status}</p>}
                    <button type="button" className="mt-2 rounded-lg border border-border px-3 py-2 font-medium disabled:opacity-50"
                      disabled={busyId === action.execution_id || ["queued", "claimed", "running", "paused"].includes(budgetJobs[action.execution_id]?.status ?? "")}
                      onClick={() => void requestBudgetReadback(action.execution_id!)}>
                      Check current Meta budget
                    </button>
                  </div>
                )}
                {action.action_key === "page_deploy" && action.execution_status === "uncertain" && action.execution_id && (
                  <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
                    <p className="font-medium">Read-only GitHub page check</p>
                    <p className="mt-1">The check reads the frozen repository path and ref. Matching bytes do not prove the page is publicly available or that its form works. No publish is retried.</p>
                    {pageReadbacks[action.execution_id] && <p className="mt-2 break-all">
                      Latest observation: {pageReadbacks[action.execution_id].result.replaceAll("_", " ")}
                      {` · ${pageReadbacks[action.execution_id].repository_owner}/${pageReadbacks[action.execution_id].repository_name}/${pageReadbacks[action.execution_id].site_path}`}
                      {` at ${pageReadbacks[action.execution_id].checked_ref}`}
                      {` · ${new Date(pageReadbacks[action.execution_id].checked_at).toLocaleString()}`}
                    </p>}
                    {pageJobs[action.execution_id] && <p className="mt-1">Latest readback job: {pageJobs[action.execution_id].status}</p>}
                    <button type="button" className="mt-2 rounded-lg border border-border px-3 py-2 font-medium disabled:opacity-50"
                      disabled={busyId === action.execution_id || ["queued", "claimed", "running", "paused"].includes(pageJobs[action.execution_id]?.status ?? "")}
                      onClick={() => void requestPageReadback(action.execution_id!)}>
                      Check GitHub page bytes
                    </button>
                  </div>
                )}
                {action.action_key === "proof_publish" && action.execution_id && (
                  <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3 text-xs">
                    <p className="font-medium">Proof release source check</p>
                    <p className="mt-1 text-muted-foreground">These are the current local placement records. An approved release still needs its destination placement receipt.</p>
                    {(proofObservations[action.execution_id] ?? []).length === 0
                      ? <p className="mt-2 text-destructive">No linked placement records were found for this action.</p>
                      : <ul className="mt-2 space-y-2">{proofObservations[action.execution_id].map((item, index) => (
                        <li key={`${item.placement_ref ?? "missing"}-${index}`} className="rounded-md bg-background p-2">
                          <span className="font-mono">{item.placement_ref ?? "Unknown placement"}</span>
                          {` · ${item.destination_key ?? "destination unknown"}`}
                          {` · approval ${item.placement_approval_status ?? "missing"}`}
                          {` · placement ${item.placement_status ?? "missing"}`}
                          {item.payload_matches === false && <span className="block text-destructive">Current payload differs from the approved version.</span>}
                          {item.retracted_at && <span className="block text-destructive">Retracted {new Date(item.retracted_at).toLocaleString()}</span>}
                          {item.external_url && <a href={item.external_url} target="_blank" rel="noreferrer" className="block break-all text-primary underline">Destination receipt</a>}
                          {!item.external_url && item.external_id && <span className="block break-all font-mono">External ID: {item.external_id}</span>}
                        </li>
                      ))}</ul>}
                  </div>
                )}
                {action.action_key === "proof_publish" && (proofRetractions[action.approval_id] ?? []).length > 0 && (
                  <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
                    <p className="font-medium">Proof removal demands</p>
                    <p className="mt-1">Withdrawal has opened a removal task for each linked placement. Check the destination before recording it as taken down.</p>
                    <ul className="mt-2 space-y-1">{proofRetractions[action.approval_id].map((item) => (
                      <li key={item.placement_id} className="break-all">
                        {`${item.placement_id} · ${item.destination_key} · ${item.demand_status.replaceAll("_", " ")}`}
                        {` · placement ${item.placement_status}`}
                        {item.external_url && <a href={item.external_url} target="_blank" rel="noreferrer" className="ml-1 text-primary underline">Destination record</a>}
                        {!item.external_url && item.external_id && ` · ${item.external_id}`}
                      </li>
                    ))}</ul>
                  </div>
                )}
                {action.action_key === "lead_message" && action.execution_id && (
                  <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3 text-xs">
                    <p className="font-medium">Lead enrolment source check</p>
                    <p className="mt-1 text-muted-foreground">This records the committed database sweep. Enrolment does not itself send a message; the courier makes separate send decisions.</p>
                    {!leadSources[action.execution_id]
                      ? <p className="mt-2 text-destructive">Source check unavailable for this execution.</p>
                      : !leadSources[action.execution_id].finished_at
                        ? <p className="mt-2 text-destructive">No committed enrolment run is recorded. Inspect before any new request.</p>
                        : <p className="mt-2">
                          {`${leadSources[action.execution_id].sequence_name ?? "Sequence"}: `}
                          {`${leadSources[action.execution_id].observed_count ?? 0} enrolment rows observed, `}
                          {`${leadSources[action.execution_id].skipped_count ?? 0} lead${leadSources[action.execution_id].skipped_count === 1 ? "" : "s"} skipped`}
                          {` · ${new Date(leadSources[action.execution_id].finished_at!).toLocaleString()}`}
                        </p>}
                  </div>
                )}
                {!revocations[action.approval_id] && <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs">
                  <input aria-label={`Reason to revoke ${action.action_key}`} value={revokeReasonById[action.approval_id] ?? ""}
                    onChange={(event) => setRevokeReasonById((prior) => ({ ...prior, [action.approval_id]: event.target.value }))}
                    placeholder="Reason to revoke future execution" className="min-w-48 flex-1 rounded-lg border border-border bg-background px-3 py-2" />
                  <button type="button" disabled={busyId === action.approval_id}
                    onClick={() => void revoke(action.approval_id)}
                    className="rounded-lg border border-destructive/50 px-3 py-2 font-medium text-destructive disabled:opacity-50">
                    Revoke future execution
                  </button>
                  {action.execution_status === "executed" && <p className="w-full text-muted-foreground">Revocation cannot undo an external effect already recorded.</p>}
                </div>}
                {action.execution_id && (
                  <div className="mt-3 border-t border-border pt-3 text-xs">
                    <p className="font-medium">Execution attempts</p>
                    {attemptsByExecution === null ? <p className="mt-1 text-destructive">Attempt receipts unavailable.</p>
                      : (attemptsByExecution[action.execution_id] ?? []).length === 0
                        ? <p className="mt-1 text-muted-foreground">No per-attempt receipt is recorded. Earlier aggregate history may be incomplete.</p>
                        : <ol className="mt-2 space-y-2">
                          {attemptsByExecution[action.execution_id].map((attempt) => (
                            <li key={attempt.attempt_number} className="rounded-md bg-muted p-2">
                              Attempt {attempt.attempt_number}: {attempt.status.replaceAll("_", " ")}
                              {attempt.legacy_inferred ? " · inferred from older execution record" : ""}
                              {` · started ${new Date(attempt.started_at).toLocaleString()}`}
                              {attempt.finished_at ? ` · finished ${new Date(attempt.finished_at).toLocaleString()}` : ""}
                              {(attempt.external_id || attempt.external_url) && <span className="block break-all font-mono">
                                Provider reference: {attempt.external_url
                                  ? <a className="underline" href={attempt.external_url} target="_blank" rel="noreferrer">{attempt.external_id ?? attempt.external_url}</a>
                                  : attempt.external_id}
                              </span>}
                              {attempt.error && <span className="block text-destructive">{attempt.error}</span>}
                            </li>
                          ))}
                        </ol>}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
