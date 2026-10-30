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

function sourcePathForRequest(request: UnifiedApprovalRequest, clientId: string): string | null {
  if (request.client_id !== clientId) return null;
  if (request.source_system === "aa_console"
    && request.source_kind === "recruitment_brief"
    && request.owner_role === "admin"
    && request.owning_path === "/team?tab=recruitment") {
    return request.owning_path;
  }
  return clientSourcePath(request.owning_path, clientId);
}

function previewMissing(request: UnifiedApprovalRequest): string | null {
  if (request.preview_blocker?.trim()) return request.preview_blocker;
  if (!request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)) {
    return "The exact artifact preview is missing.";
  }
  if (Object.keys(request.preview).length === 0) return "The exact artifact preview is empty.";
  if (!request.artifact_hash?.trim()) return "The artifact version hash is missing.";
  if (!request.source_version?.trim()) return "The source version is missing.";
  if (!request.expires_at) return "The approval expiry is missing.";
  if (!request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)
    || Object.keys(request.scope).length === 0) return "The exact scope is missing.";
  return null;
}

function isExpired(request: UnifiedApprovalRequest): boolean {
  return !request.expires_at || !Number.isFinite(Date.parse(request.expires_at))
    || Date.parse(request.expires_at) <= Date.now();
}

function isCampaignRejectionReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  return request.source_system === "aa_console"
    && request.source_kind === "campaign_action"
    && request.client_id === clientId
    && (request.status === "pending" || request.status === "expired")
    && !previewMissing(request);
}

function isCampaignApprovalReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  return isCampaignRejectionReady(request, clientId)
    && request.status === "pending" && !isExpired(request);
}

function isGoogleReplyRejectionReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "google_review_reply"
    || request.client_id !== clientId
    || (request.status !== "pending" && request.status !== "expired")
    || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const location = preview.location_ref;
  const review = preview.review_ref;
  const bodyHash = preview.reply_body_sha256;
  return typeof location === "string" && !!location.trim()
    && typeof review === "string" && !!review.trim()
    && typeof preview.reply_body === "string" && !!preview.reply_body.trim()
    && typeof bodyHash === "string" && /^[0-9a-f]{64}$/.test(bodyHash)
    && request.source_version === request.artifact_hash
    && request.account_ref === location
    && request.destination === `google_business:${location}/reviews/${review}/reply`
    && scope.client_id === clientId && scope.reply_id === request.source_id
    && scope.review_id === preview.review_id && scope.review_ref === review
    && scope.location_ref === location && scope.body_hash === bodyHash;
}

function isGoogleReplyApprovalReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  return isGoogleReplyRejectionReady(request, clientId)
    && request.status === "pending" && !isExpired(request);
}

function isRejectionReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  return isCampaignRejectionReady(request, clientId)
    || isGoogleReplyRejectionReady(request, clientId);
}

function isApprovalReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  return isCampaignApprovalReady(request, clientId)
    || isGoogleReplyApprovalReady(request, clientId);
}

function sameVersion(left: UnifiedApprovalRequest, right: UnifiedApprovalRequest): boolean {
  return left.id === right.id && left.source_id === right.source_id
    && left.client_id === right.client_id && left.source_system === right.source_system
    && left.source_kind === right.source_kind && left.owner_role === right.owner_role
    && left.source_version === right.source_version
    && left.status === right.status
    && left.expires_at === right.expires_at
    && left.artifact_hash === right.artifact_hash
    && left.destination === right.destination
    && left.account_ref === right.account_ref
    && left.preview_blocker === right.preview_blocker
    && JSON.stringify(left.preview) === JSON.stringify(right.preview)
    && JSON.stringify(left.scope) === JSON.stringify(right.scope)
    && JSON.stringify(left.budget) === JSON.stringify(right.budget);
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

function RequestCard({ request, history, clientId, aal, busy, onDecide }: {
  request: UnifiedApprovalRequest;
  history: UnifiedApprovalDecision[];
  clientId: string;
  aal: "aal2" | "aal1" | "unavailable";
  busy: boolean;
  onDecide: (request: UnifiedApprovalRequest, decision: "approved" | "rejected", reason?: string) => Promise<void>;
}) {
  const [rejectionReason, setRejectionReason] = useState("");
  const blocker = previewMissing(request);
  const sourcePath = sourcePathForRequest(request, clientId);
  const html = exactHtml(request.preview);
  const canReject = isRejectionReady(request, clientId);
  const canApprove = isApprovalReady(request, clientId);
  const decisionLabel = request.source_kind === "google_review_reply"
    ? "Google review reply" : "Campaign action";

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
        <p className="mt-4 text-xs text-muted-foreground">Exact-version snapshot recorded. Decisions use the owning source's approval function.</p>
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

      {canReject && (
        <div className="mt-4 space-y-3 rounded-lg border border-border p-3">
          <p className="text-sm font-medium">{decisionLabel} decision</p>
          <p className="text-xs text-muted-foreground">
            This calls the source owner for the exact version above. AAL2 is required;
            the source and database recheck the request before recording a decision.
          </p>
          {!canApprove && <p className="text-xs text-muted-foreground">
            This request has expired. It can only be closed with a reasoned rejection.
          </p>}
          {aal !== "aal2" && <p role="status" className="text-sm text-destructive">
            {aal === "aal1" ? "Complete MFA to reach AAL2 before deciding." : "MFA level could not be verified; decisions are unavailable."}
          </p>}
          <div className="flex flex-wrap gap-2">
            {canApprove && <button type="button" disabled={busy || aal !== "aal2"}
              onClick={() => void onDecide(request, "approved")}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
              Approve exact version
            </button>}
            <label className="min-w-48 flex-1 text-sm">Reason to reject
              <input value={rejectionReason} onChange={(event) => setRejectionReason(event.target.value)}
                disabled={busy || aal !== "aal2"} className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
            </label>
            <button type="button" disabled={busy || aal !== "aal2" || !rejectionReason.trim()}
              onClick={() => void onDecide(request, "rejected", rejectionReason.trim())}
              className="self-end rounded-lg border border-border px-4 py-2 text-sm font-medium disabled:opacity-50">
              Reject with reason
            </button>
          </div>
        </div>
      )}

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
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [aal, setAal] = useState<"aal2" | "aal1" | "unavailable">("unavailable");

  const refresh = useCallback(async () => {
    if (!clientId) return;
    try {
      const requestResult = await supabase.from("approval_inbox_v6")
        .select("*").eq("client_id", clientId).order("requested_at", { ascending: false });
      if (requestResult.error) throw requestResult.error;
      const rows: UnifiedApprovalRequest[] = requestResult.data ?? [];
      const ids = rows.map((row) => row.id);
      let decisionRows: UnifiedApprovalDecision[] = [];
      if (ids.length > 0) {
        const decisionResult = await supabase.from("approval_decision_events_v6")
          .select("request_id,decision,actor_id,actor_aal,reason,decided_at")
          .in("request_id", ids).order("decided_at", { ascending: false });
        if (decisionResult.error) throw decisionResult.error;
        decisionRows = decisionResult.data ?? [];
      }
      try {
        const assurance = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        setAal(assurance.error ? "unavailable"
          : assurance.data.currentLevel === "aal2" ? "aal2" : "aal1");
      } catch {
        setAal("unavailable");
      }
      setRequests(rows);
      setDecisions(decisionRows);
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

  async function decide(request: UnifiedApprovalRequest, decision: "approved" | "rejected", reason?: string) {
    if (!clientId || (decision === "approved"
      ? !isApprovalReady(request, clientId)
      : !isRejectionReady(request, clientId))) return;
    setBusyId(request.id);
    setDecisionError(null);
    try {
      const assurance = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (assurance.error || assurance.data.currentLevel !== "aal2") {
        setAal(assurance.error ? "unavailable" : "aal1");
        throw new Error("Complete MFA to reach AAL2 before deciding this request.");
      }
      setAal("aal2");

      const current = await supabase.from("approval_inbox_v6").select("*")
        .eq("id", request.id).eq("client_id", clientId).maybeSingle();
      if (current.error) throw current.error;
      if (!current.data || (decision === "approved"
        ? !isApprovalReady(current.data, clientId)
        : !isRejectionReady(current.data, clientId))
        || !sameVersion(request, current.data)) {
        throw new Error("This exact request changed or is no longer pending. Review the refreshed card before deciding.");
      }
      if (decision === "rejected" && !reason?.trim()) {
        throw new Error("Enter a reason before rejecting this request.");
      }
      const outcome = request.source_kind === "google_review_reply"
        ? await supabase.rpc("decide_google_review_reply_from_inbox_v6", {
          p_reply_id: request.source_id,
          p_expected_source_version: request.source_version,
          p_expected_artifact_hash: request.artifact_hash!,
          p_approved: decision === "approved",
          ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
        })
        : await supabase.rpc("decide_campaign_action_approval_v6", {
          p_request_id: request.source_id,
          p_decision: decision,
          ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
        });
      if (outcome.error) throw outcome.error;
      setStatusFilter("all");
      await refresh();
    } catch (cause) {
      setDecisionError(cause instanceof Error ? cause.message
        : (cause as { message?: string }).message ?? "The decision could not be recorded.");
      await refresh();
    } finally {
      setBusyId(null);
    }
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
          Complete campaign action and Google review reply requests can be decided here through their owning functions.
          Other requests link to their owning source. Coverage is incomplete: the Engine,
          Assets and Campaign actions tabs remain available for work not yet mirrored here.
        </p>
      </div>

      <div className="flex flex-wrap gap-3 rounded-xl border border-border bg-card p-4">
        <label className="min-w-40 flex-1 text-sm font-medium">Status
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}
            className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">
            <option value="pending">Pending</option><option value="approved">Approved</option>
            <option value="rejected">Rejected</option><option value="expired">Expired</option>
            <option value="all">All statuses</option>
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
      {decisionError && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{decisionError}</p>}
      {clientId && waiting ? <p role="status" className="text-sm text-muted-foreground">Loading canonical requests…</p>
        : error ? null
          : clientId ? <>
            <p className="text-sm text-muted-foreground">Showing {visible.length} of {requests.length} mirrored requests.</p>
            {visible.length === 0 ? <p className="text-sm text-muted-foreground">
              {requests.length === 0 ? "No requests have been mirrored yet. Check the existing queue tabs for outstanding work."
                : "No requests match these filters."}
            </p> : <div className="space-y-4">{visible.map((request) => (
              <RequestCard key={request.id} request={request} history={historyByRequest.get(request.id) ?? []}
                clientId={clientId ?? ""} aal={aal} busy={busyId === request.id} onDecide={decide} />
            ))}</div>}
          </> : null}
    </section>
  );
}
