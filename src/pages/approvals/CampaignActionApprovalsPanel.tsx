import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";
import {
  EXECUTION_HINT,
  fetchCampaignActionDue,
  fetchCampaignActionsEnabled,
  setCampaignActionsEnabled,
  type CampaignActionDue,
} from "../../lib/campaignActions";

type Approval = Database["public"]["Tables"]["campaign_action_approvals"]["Row"];
type PageSnapshot = Database["public"]["Tables"]["campaign_page_approval_snapshots"]["Row"];

export function CampaignActionApprovalsPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [requests, setRequests] = useState<Approval[]>([]);
  const [pageSnapshots, setPageSnapshots] = useState<Record<string, PageSnapshot>>({});
  const [decided, setDecided] = useState<CampaignActionDue[]>([]);
  const [actionsOn, setActionsOn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reasonById, setReasonById] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setRequests([]);
      setPageSnapshots({});
      setDecided([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    // What happened after the last yes. Read before the pending list so that
    // a failure reading it cannot leave the outcomes of previous decisions
    // looking like an empty list, which reads as "nothing has happened".
    try {
      const [due, on] = await Promise.all([
        fetchCampaignActionDue(clientId),
        fetchCampaignActionsEnabled(clientId),
      ]);
      setDecided(due);
      setActionsOn(on);
    } catch (cause) {
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
        Generic campaign action claims are held before the worker reads or claims an approval.
        The current database claim cannot atomically limit work to actions this runtime handles.
        A client switch or approval does not release this hold.
      </p>

      {/* The client switch. Approving an action and switching the client on
          are two separate acts on purpose: a decision about one campaign is
          not consent for a machine to act on this client's behalf at all. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
        <div>
          <p className="text-sm font-medium">
            External campaign actions are {actionsOn ? "on" : "off"} for this client
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {actionsOn
              ? "This client switch is on, but the generic worker is held before claim. Each action still needs its own exact-version approval."
              : "The generic worker is held before claim. Approvals are still recorded."}
          </p>
        </div>
        <button
          type="button"
          disabled={!clientId || busyId === "switch" || !actionsOn}
          onClick={() => {
            if (!clientId) return;
            setBusyId("switch");
            setError(null);
            void setCampaignActionsEnabled(clientId, !actionsOn)
              .then(() => refresh())
              .catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : "Could not change that."),
              )
              .finally(() => setBusyId(null));
          }}
          className="rounded-lg border border-border px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {actionsOn ? "Turn off" : "Turn on (held)"}
        </button>
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
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">After the decision</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Approved actions, and why each has or has not been performed. The database due view
            does not include this runtime's generic preclaim hold.
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
                      {action.blocker ?? "Database due; the generic runtime worker is held before claim."}
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
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
