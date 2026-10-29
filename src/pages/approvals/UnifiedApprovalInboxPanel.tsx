import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { supabase } from "../../lib/supabase";

/**
 * The read projection for B008. The owning source keeps its decision RPC;
 * this screen never turns a mirrored row into a second authority.
 */
export interface UnifiedApprovalRequest {
  id: string;
  client_id: string | null;
  source_system: string;
  source_kind: string;
  source_id: string;
  source_version: string;
  title: string;
  status: string;
  requested_at: string;
  expires_at: string | null;
  artifact_hash: string | null;
  preview: unknown;
  destination: string | null;
  account_ref: string | null;
  budget: unknown;
  scope: unknown;
  owner_role: string | null;
  preview_blocker: string | null;
  owning_path: string | null;
}

export interface UnifiedApprovalDecision {
  request_id: string;
  decision: string;
  actor_id: string | null;
  actor_aal: string | null;
  reason: string | null;
  decided_at: string;
}

type ReadResult = {
  data: unknown[] | null;
  error: { message: string } | null;
};

type ReadQuery = {
  select: (columns: string) => ReadQuery;
  eq: (column: string, value: string) => ReadQuery;
  in: (column: string, values: string[]) => ReadQuery;
  order: (column: string, options?: { ascending: boolean }) => Promise<ReadResult>;
};

// The canonical view/table are introduced by migration 273+. Keep this small
// read adapter until generated Database types include them. It cannot write.
const approvalReadDb = supabase as unknown as { from: (table: string) => ReadQuery };

function printable(value: unknown): string {
  if (value === null || value === undefined) return "Not supplied";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "Not supplied";
}

function dateLabel(value: string | null): string {
  if (!value) return "Not set";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** Reject untrusted or cross-client paths supplied by a projection row. */
function clientSourcePath(path: string | null, clientId: string): string | null {
  if (!path?.startsWith("/")) return null;
  try {
    const url = new URL(path, "https://approval-inbox.invalid");
    if (url.origin !== "https://approval-inbox.invalid"
      || !url.pathname.startsWith(`/clients/${encodeURIComponent(clientId)}/`)) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function previewMissing(request: UnifiedApprovalRequest): string | null {
  if (request.preview_blocker?.trim()) return request.preview_blocker;
  if (request.preview === null || request.preview === undefined || request.preview === "") {
    return "The exact artifact preview is missing.";
  }
  if (!request.artifact_hash?.trim()) return "The artifact version hash is missing.";
  if (!request.source_version?.trim()) return "The source version is missing.";
  return null;
}

function statusTone(status: string): string {
  switch (status.toLowerCase()) {
    case "pending": return "border-amber-300 bg-amber-50 text-amber-900";
    case "approved": return "border-green-300 bg-green-50 text-green-900";
    case "rejected": return "border-red-300 bg-red-50 text-red-900";
    default: return "border-border bg-muted text-foreground";
  }
}

function exactHtml(preview: unknown): string | null {
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) return null;
  const html = (preview as Record<string, unknown>).rendered_html;
  return typeof html === "string" && html.trim() ? html : null;
}

function RequestCard({ request, history, clientId }: {
  request: UnifiedApprovalRequest;
  history: UnifiedApprovalDecision[];
  clientId: string;
}) {
  const blocker = previewMissing(request);
  const sourcePath = clientSourcePath(request.owning_path, clientId);
  const html = exactHtml(request.preview);

  return (
    <article className="rounded-xl border border-border bg-card p-5" aria-labelledby={`approval-${request.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id={`approval-${request.id}`} className="text-base font-semibold">{request.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {request.source_system} · {request.source_kind.replaceAll("_", " ")}
          </p>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${statusTone(request.status)}`}>
          {request.status.replaceAll("_", " ")}
        </span>
      </div>

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-muted-foreground">Requested</dt><dd>{dateLabel(request.requested_at)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Expires</dt><dd>{dateLabel(request.expires_at)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Decision owner</dt><dd>{request.owner_role || "Not assigned"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Destination</dt><dd className="break-all">{request.destination || "Not supplied"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Account</dt><dd className="break-all">{request.account_ref || "Not supplied"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Source version</dt><dd className="break-all font-mono text-xs">{request.source_version || "Not supplied"}</dd></div>
        <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">Exact artifact hash</dt><dd className="break-all font-mono text-xs">{request.artifact_hash || "Not supplied"}</dd></div>
      </dl>

      {blocker ? (
        <p role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          Incomplete preview: {blocker} This request is not decision-ready.
        </p>
      ) : (
        <p className="mt-4 text-xs text-muted-foreground">Exact-version snapshot recorded. The owning source still decides this request.</p>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <h4 className="text-sm font-medium">Exact-version preview</h4>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">{printable(request.preview)}</pre>
        </div>
        <div className="space-y-4">
          <div><h4 className="text-sm font-medium">Approved scope</h4>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">{printable(request.scope)}</pre>
          </div>
          <div><h4 className="text-sm font-medium">Budget</h4>
            <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">{printable(request.budget)}</pre>
          </div>
        </div>
      </div>

      {html && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium">Visual page preview</summary>
          <p className="mt-2 text-xs text-muted-foreground">Scripts, forms and external resources are disabled.</p>
          <iframe title={`Preview of ${request.title}`} sandbox="" referrerPolicy="no-referrer"
            srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'">${html}`}
            className="mt-2 h-80 w-full rounded-lg border border-border bg-white" />
        </details>
      )}

      <details className="mt-4 rounded-lg border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">Decision history ({history.length})</summary>
        {history.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No decision has been recorded for this request.</p> : (
          <ol className="mt-3 space-y-3">
            {history.map((event, index) => (
              <li key={`${event.decided_at}-${index}`} className="border-t border-border pt-2 text-xs">
                <p className="font-medium">{event.decision.replaceAll("_", " ")} · {dateLabel(event.decided_at)}</p>
                <p className="mt-1 text-muted-foreground">Human: {event.actor_id || "Not recorded"} · Assurance: {event.actor_aal || "Not recorded"}</p>
                {event.reason && <p className="mt-1 whitespace-pre-wrap">Reason: {event.reason}</p>}
              </li>
            ))}
          </ol>
        )}
      </details>

      <div className="mt-4">
        {sourcePath ? (
          <Link className="text-sm font-medium text-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            to={sourcePath}>View owning source</Link>
        ) : <span className="text-xs text-muted-foreground">Owning source link unavailable.</span>}
      </div>
    </article>
  );
}

export function UnifiedApprovalInboxPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [requests, setRequests] = useState<UnifiedApprovalRequest[]>([]);
  const [decisions, setDecisions] = useState<UnifiedApprovalDecision[]>([]);
  const [statusFilter, setStatusFilter] = useState("pending");
  const [kindFilter, setKindFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadedClientId, setLoadedClientId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    try {
      const requestResult = await approvalReadDb.from("approval_inbox_v6")
        .select("*").eq("client_id", clientId).order("requested_at", { ascending: false });
      if (requestResult.error) throw requestResult.error;
      const rows = (requestResult.data ?? []) as UnifiedApprovalRequest[];
      const ids = rows.map((row) => row.id);
      const decisionResult = ids.length === 0 ? { data: [], error: null } : await approvalReadDb
        .from("approval_decision_events_v6").select("request_id,decision,actor_id,actor_aal,reason,decided_at")
        .in("request_id", ids).order("decided_at", { ascending: false });
      if (decisionResult.error) throw decisionResult.error;
      setRequests(rows);
      setDecisions((decisionResult.data ?? []) as UnifiedApprovalDecision[]);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : (cause as { message?: string }).message ?? "Could not load the unified approval inbox.");
    } finally {
      setLoadedClientId(clientId);
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void refresh(); });
    return () => { cancelled = true; };
  }, [refresh]);

  function retry() {
    setLoading(true);
    setError(null);
    void refresh();
  }

  const waiting = loading || loadedClientId !== clientId;

  const kinds = useMemo(() => [...new Set(requests.map((request) => request.source_kind))].sort(), [requests]);
  const visible = useMemo(() => requests.filter((request) => {
    if (statusFilter !== "all" && request.status !== statusFilter) return false;
    if (kindFilter !== "all" && request.source_kind !== kindFilter) return false;
    const needle = search.trim().toLocaleLowerCase();
    return !needle || [request.title, request.source_system, request.source_kind,
      request.destination, request.account_ref].some((part) => part?.toLocaleLowerCase().includes(needle));
  }), [requests, statusFilter, kindFilter, search]);

  const historyByRequest = useMemo(() => {
    const grouped = new Map<string, UnifiedApprovalDecision[]>();
    for (const decision of decisions) {
      const group = grouped.get(decision.request_id) ?? [];
      group.push(decision);
      grouped.set(decision.request_id, group);
    }
    return grouped;
  }, [decisions]);

  return (
    <section className="space-y-5" aria-labelledby="unified-approvals-title">
      <div>
        <h2 id="unified-approvals-title" className="text-xl font-semibold">Unified approval inbox</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Canonical requests and decision history appear here as source adapters are connected.
          Open the owning source to make a decision. The Engine, Assets and Campaign actions tabs
          remain available for work not yet mirrored here.
        </p>
      </div>

      <div className="flex flex-wrap gap-3 rounded-xl border border-border bg-card p-4">
        <label className="min-w-40 flex-1 text-sm font-medium">Status
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}
            className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">
            <option value="pending">Pending</option><option value="approved">Approved</option>
            <option value="rejected">Rejected</option><option value="all">All statuses</option>
          </select>
        </label>
        <label className="min-w-40 flex-1 text-sm font-medium">Source type
          <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value)}
            className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">
            <option value="all">All source types</option>
            {kinds.map((kind) => <option key={kind} value={kind}>{kind.replaceAll("_", " ")}</option>)}
          </select>
        </label>
        <label className="min-w-48 flex-[2] text-sm font-medium">Search
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)}
            placeholder="Title, source, destination or account"
            className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
        </label>
      </div>

      {!clientId && <p role="alert" className="text-sm text-destructive">Select a client to view approvals.</p>}
      {error && !waiting && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        <p>{error}</p><button type="button" onClick={retry} className="mt-2 underline">Retry</button>
      </div>}
      {clientId && waiting ? <p role="status" className="text-sm text-muted-foreground">Loading canonical requests…</p>
        : error ? null
          : clientId ? <>
            <p className="text-sm text-muted-foreground">Showing {visible.length} of {requests.length} mirrored requests.</p>
            {visible.length === 0 ? <p className="text-sm text-muted-foreground">
              {requests.length === 0 ? "No requests have been mirrored yet. Check the existing queue tabs for outstanding work."
                : "No requests match these filters."}
            </p> : <div className="space-y-4">{visible.map((request) => (
              <RequestCard key={request.id} request={request} history={historyByRequest.get(request.id) ?? []}
                clientId={clientId ?? ""} />
            ))}</div>}
          </> : null}
    </section>
  );
}
