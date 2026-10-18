import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

type Approval = Database["public"]["Tables"]["campaign_action_approvals"]["Row"];
type PageSnapshot = Database["public"]["Tables"]["campaign_page_approval_snapshots"]["Row"];

export function CampaignActionApprovalsPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [requests, setRequests] = useState<Approval[]>([]);
  const [pageSnapshots, setPageSnapshots] = useState<Record<string, PageSnapshot>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reasonById, setReasonById] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setRequests([]);
      setPageSnapshots({});
      setLoading(false);
      return;
    }
    setLoading(true);
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
          Approved requests remain internal until a verified action executor is connected.
        </p>
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
                <Link className="text-sm text-primary underline" to={`/clients/${clientId}/delivery/campaign-factory/${request.campaign_id}?view=v2`}>
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
    </div>
  );
}
