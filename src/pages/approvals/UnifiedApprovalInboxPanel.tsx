import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";

import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

const PAGE_SIZE = 50;
type ApprovalViewRow = Database["public"]["Views"]["approval_inbox_v6"]["Row"];

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
  source_state?: string | null;
  requested_at: string;
  requested_by: string | null;
  requester_kind: string;
  requester_ref: string | null;
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
  event_order?: number;
}

function validatedRequest(row: ApprovalViewRow): UnifiedApprovalRequest {
  for (const key of ["id", "source_system", "source_kind", "source_id",
    "source_version", "title", "status", "requested_at", "requester_kind"] as const) {
    if (typeof row[key] !== "string" || !row[key]?.trim()) {
      throw new Error(`Approval projection has no valid ${key}; this page cannot safely decide it.`);
    }
  }
  return row as UnifiedApprovalRequest;
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

function isRecruitmentBriefApprovalReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "recruitment_brief"
    || request.client_id !== clientId || request.owner_role !== "admin"
    || request.status !== "pending" || isExpired(request) || previewMissing(request)
    || request.destination !== "internal:recruitment_ad_generation"
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  return typeof request.artifact_hash === "string" && /^[0-9a-f]{64}$/.test(request.artifact_hash)
    && request.source_version.startsWith(`${request.artifact_hash}:v`)
    && /^[1-9][0-9]*$/.test(request.source_version.slice(request.artifact_hash.length + 2))
    && preview.id === request.source_id && preview.client_id === clientId
    && preview.purpose === "recruitment" && preview.media_type === "image"
    && typeof preview.title === "string" && !!preview.title.trim()
    && typeof preview.hook === "string" && !!preview.hook.trim()
    && typeof preview.script === "string" && !!preview.script.trim()
    && typeof preview.call_to_action === "string" && !!preview.call_to_action.trim()
    && typeof preview.apply_url === "string" && preview.apply_url.startsWith("https://")
    && scope.purpose === "recruitment"
    && scope.recruitment_role === preview.recruitment_role
    && scope.media_type === "image" && scope.apply_url === preview.apply_url;
}

function isRejectionReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  return isCampaignRejectionReady(request, clientId)
    || isGoogleReplyRejectionReady(request, clientId);
}

function isApprovalReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  return isCampaignApprovalReady(request, clientId)
    || isGoogleReplyApprovalReady(request, clientId)
    || isRecruitmentBriefApprovalReady(request, clientId);
}

function sameVersion(left: UnifiedApprovalRequest, right: UnifiedApprovalRequest): boolean {
  return left.id === right.id && left.source_id === right.source_id
    && left.client_id === right.client_id && left.source_system === right.source_system
    && left.source_kind === right.source_kind && left.owner_role === right.owner_role
    && left.source_version === right.source_version
    && left.status === right.status
    && left.source_state === right.source_state
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

function RequestCard({ request, history, clientId, manager, aal, busy, onDecide }: {
  request: UnifiedApprovalRequest;
  history: UnifiedApprovalDecision[];
  clientId: string;
  manager: boolean;
  aal: "aal2" | "aal1" | "unavailable";
  busy: boolean;
  onDecide: (request: UnifiedApprovalRequest, decision: "approved" | "rejected", reason?: string) => Promise<void>;
}) {
  const [rejectionReason, setRejectionReason] = useState("");
  const location = useLocation();
  const blocker = previewMissing(request);
  const sourcePath = manager ? null : sourcePathForRequest(request, clientId);
  const html = exactHtml(request.preview);
  const canReject = isRejectionReady(request, clientId);
  const canApprove = isApprovalReady(request, clientId);
  const decisionLabel = request.source_kind === "google_review_reply"
    ? "Google review reply" : request.source_kind === "recruitment_brief"
      ? "Recruitment brief" : "Campaign action";

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
        <div><dt className="text-xs text-muted-foreground">Client</dt><dd className="break-all">{request.client_id || "Agency-wide"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Requested</dt><dd>{dateLabel(request.requested_at)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Request origin</dt><dd className="break-all">
          {request.requester_kind === "human"
            ? `Human ${request.requested_by || "unidentified"}`
            : `${request.requester_kind}${request.requester_ref ? ` · ${request.requester_ref}` : ""}`}
        </dd></div>
        <div><dt className="text-xs text-muted-foreground">Expires</dt><dd>{dateLabel(request.expires_at)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Decision owner</dt><dd>{request.owner_role || "Not assigned"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Destination</dt><dd className="break-all">{request.destination || "Not supplied"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Account</dt><dd className="break-all">{request.account_ref || "Not supplied"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Source version</dt><dd className="break-all font-mono text-xs">{request.source_version || "Not supplied"}</dd></div>
        {request.source_state && <div><dt className="text-xs text-muted-foreground">Live source state</dt>
          <dd>{request.source_state.replaceAll("_", " ")}</dd></div>}
        <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">Exact artifact hash</dt><dd className="break-all font-mono text-xs">{request.artifact_hash || "Not supplied"}</dd></div>
      </dl>

      {blocker ? (
        <p role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          Incomplete preview: {blocker} This request is not decision-ready.
        </p>
      ) : (
        <p className="mt-4 text-xs text-muted-foreground">Exact-version snapshot recorded. Decisions use the owning source's approval function.</p>
      )}
      {request.source_state && request.source_state !== "pending"
        && request.status !== "approved" && request.status !== "rejected"
        && request.status !== "revoked" && <p role="alert" className="mt-3 text-sm text-destructive">
          The owning source is {request.source_state.replaceAll("_", " ")}. This card cannot be decided.
        </p>}

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
              <li key={event.event_order ?? `${event.decided_at}-${index}`} className="border-t border-border pt-2 text-xs">
                <p className="font-medium">{event.decision.replaceAll("_", " ")} · {dateLabel(event.decided_at)}</p>
                <p className="mt-1 text-muted-foreground">Human: {event.actor_id || "Not recorded"} · Assurance: {event.actor_aal || "Not recorded"}</p>
                {event.reason && <p className="mt-1 whitespace-pre-wrap">Reason: {event.reason}</p>}
              </li>
            ))}
          </ol>
        )}
      </details>

      {(canApprove || canReject) && (
        <div className="mt-4 space-y-3 rounded-lg border border-border p-3">
          <p className="text-sm font-medium">{decisionLabel} decision</p>
          <p className="text-xs text-muted-foreground">
            This calls the source owner for the exact version above. AAL2 is required;
            the source and database recheck the request before recording a decision.
          </p>
          {!canApprove && canReject && <p className="text-xs text-muted-foreground">
            This request has expired. It can only be closed with a reasoned rejection.
          </p>}
          {aal !== "aal2" && <p role="status" className="text-sm text-destructive">
            {aal === "aal1" ? "Complete MFA to reach AAL2 before deciding." : "MFA level could not be verified; decisions are unavailable."}{" "}
            <Link to="/security/mfa" state={{ returnTo: `${location.pathname}${location.search}` }} className="underline">Open account security</Link>
          </p>}
          <div className="flex flex-wrap gap-2">
            {canApprove && <button type="button" disabled={busy || aal !== "aal2"}
              onClick={() => void onDecide(request, "approved")}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
              Approve exact version
            </button>}
            {canReject && <label className="min-w-48 flex-1 text-sm">Reason to reject
              <input value={rejectionReason} onChange={(event) => setRejectionReason(event.target.value)}
                disabled={busy || aal !== "aal2"} className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
            </label>}
            {canReject && <button type="button" disabled={busy || aal !== "aal2" || !rejectionReason.trim()}
              onClick={() => void onDecide(request, "rejected", rejectionReason.trim())}
              className="self-end rounded-lg border border-border px-4 py-2 text-sm font-medium disabled:opacity-50">
              Reject with reason
            </button>}
          </div>
        </div>
      )}

      <div className="mt-4">
        {sourcePath ? (
          <Link className="text-sm font-medium text-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            to={sourcePath}>View owning source</Link>
        ) : <span className="text-xs text-muted-foreground">
          {manager ? "Owning source is unavailable from the manager console." : "Owning source link unavailable."}
        </span>}
      </div>
    </article>
  );
}

export function UnifiedApprovalInboxPanel({ scope = "client" }: { scope?: "client" | "global" | "manager" }) {
  const { clientId } = useParams<{ clientId: string }>();
  const location = useLocation();
  const global = scope === "global";
  const manager = scope === "manager";
  const multiClient = global || manager;
  const scopeKey = multiClient ? scope : clientId ?? null;
  const initialSource = new URLSearchParams(location.search).get("source");
  const [requests, setRequests] = useState<UnifiedApprovalRequest[]>([]);
  const [decisions, setDecisions] = useState<UnifiedApprovalDecision[]>([]);
  const [statusFilter, setStatusFilter] = useState(initialSource ? "all" : "pending");
  const [clientFilter, setClientFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [search, setSearch] = useState(initialSource ?? "");
  const [sourceDeepLink, setSourceDeepLink] = useState(initialSource);
  const [pageState, setPageState] = useState({ scopeKey, page: 0 });
  const page = pageState.scopeKey === scopeKey ? pageState.page : 0;
  const [hasNextPage, setHasNextPage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadedClientId, setLoadedClientId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [aal, setAal] = useState<"aal2" | "aal1" | "unavailable">("unavailable");
  const refreshSequence = useRef(0);

  const refresh = useCallback(async () => {
    if (!multiClient && !clientId) return;
    const sequence = ++refreshSequence.current;
    setLoading(true);
    try {
      let query = supabase.from("approval_inbox_v6").select("*");
      if (!multiClient) query = query.eq("client_id", clientId!);
      else if (manager) query = query.eq("owner_role", "admin_or_active_client_manager");
      else if (clientFilter === "agency-wide") query = query.is("client_id", null);
      else if (clientFilter !== "all") query = query.eq("client_id", clientFilter);
      if (statusFilter !== "all") query = query.eq("status", statusFilter);
      if (kindFilter !== "all") query = query.eq("source_kind", kindFilter);
      if (sourceDeepLink) query = query.eq("source_id", sourceDeepLink);
      // Fetch one sentinel row so the next-page control is based on evidence.
      // Each history query is then bounded to the 50 cards actually displayed.
      const requestResult = await query.order("requested_at", { ascending: false })
        .order("id", { ascending: false })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
      if (requestResult.error) throw requestResult.error;
      const pageRows = (requestResult.data ?? []).map(validatedRequest);
      const rows = pageRows.slice(0, PAGE_SIZE);
      const ids = rows.map((row) => row.id);
      let decisionRows: UnifiedApprovalDecision[] = [];
      if (ids.length > 0) {
        const decisionResult = await supabase.from("approval_decision_events_v6")
          .select("request_id,decision,actor_id,actor_aal,reason,decided_at,event_order")
          .in("request_id", ids).order("event_order", { ascending: false });
        if (decisionResult.error) throw decisionResult.error;
        decisionRows = decisionResult.data ?? [];
      }
      if (sequence !== refreshSequence.current) return;
      try {
        const assurance = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (sequence !== refreshSequence.current) return;
        setAal(assurance.error ? "unavailable"
          : assurance.data.currentLevel === "aal2" ? "aal2" : "aal1");
      } catch {
        setAal("unavailable");
      }
      setRequests(rows);
      setDecisions(decisionRows);
      setHasNextPage(pageRows.length > PAGE_SIZE);
      setError(null);
    } catch (cause) {
      if (sequence === refreshSequence.current) {
        setError(cause instanceof Error ? cause.message : (cause as { message?: string }).message ?? "Could not load the unified approval inbox.");
      }
    } finally {
      if (sequence === refreshSequence.current) {
        setLoadedClientId(scopeKey);
        setLoading(false);
      }
    }
  }, [clientId, clientFilter, kindFilter, manager, multiClient, page, scopeKey, sourceDeepLink, statusFilter]);

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
    const targetClientId = multiClient ? request.client_id : clientId;
    if (!targetClientId || request.client_id !== targetClientId || (decision === "approved"
      ? !isApprovalReady(request, targetClientId)
      : !isRejectionReady(request, targetClientId))) return;
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
        .eq("id", request.id).eq("client_id", targetClientId).maybeSingle();
      if (current.error) throw current.error;
      const currentRequest = current.data ? validatedRequest(current.data) : null;
      if (!currentRequest || (decision === "approved"
        ? !isApprovalReady(currentRequest, targetClientId)
        : !isRejectionReady(currentRequest, targetClientId))
        || !sameVersion(request, currentRequest)) {
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
        : request.source_kind === "recruitment_brief"
          ? await supabase.rpc("approve_recruitment_brief_from_inbox_v6", {
            p_brief_id: request.source_id,
            p_request_id: request.id,
            p_expected_source_version: request.source_version,
            p_expected_artifact_hash: request.artifact_hash!,
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

  const waiting = loading || loadedClientId !== scopeKey;

  const kinds = useMemo(() => [...new Set([
    ...requests.map((request) => request.source_kind),
    ...(kindFilter === "all" ? [] : [kindFilter]),
  ])].sort(), [requests, kindFilter]);
  const clients = useMemo(() => [...new Set([
    ...requests.map((request) => request.client_id ?? "agency-wide"),
    ...(clientFilter === "all" ? [] : [clientFilter]),
  ])].sort(), [requests, clientFilter]);
  const visible = useMemo(() => requests.filter((request) => {
    const needle = search.trim().toLocaleLowerCase();
    return !needle || [request.title, request.source_id, request.source_system, request.source_kind,
      request.destination, request.account_ref].some((part) => part?.toLocaleLowerCase().includes(needle));
  }), [requests, search]);

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
        <h2 id="unified-approvals-title" className="text-xl font-semibold">
          {global ? "Agency approval inbox" : manager ? "Manager approval inbox" : "Unified approval inbox"}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {global ? "Canonical requests across every client and the agency house client appear here. "
            : manager ? "Canonical requests for clients currently assigned to you appear here. "
              : "Canonical requests and decision history appear here as source adapters are connected. "}
          {manager
            ? "Complete campaign action and Google review reply requests can be decided here through their owning functions."
            : "Complete campaign action, Google review reply and recruitment brief requests can be decided here through their owning functions."}
          {manager ? " Other requests remain read-only. " : " Other requests link to their owning source. "}
          Coverage is incomplete: work not yet mirrored here remains in its owning queue.
          Pending here reflects the canonical ledger; each owning source is checked again before a decision.
        </p>
      </div>

      <div className="flex flex-wrap gap-3 rounded-xl border border-border bg-card p-4">
        <label className="min-w-40 flex-1 text-sm font-medium">Status
          <select value={statusFilter} onChange={(event) => {
            setStatusFilter(event.target.value); setPageState({ scopeKey, page: 0 });
          }}
            className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">
            <option value="pending">Pending</option><option value="approved">Approved</option>
            <option value="rejected">Rejected</option><option value="expired">Expired</option>
            <option value="revoked">Revoked</option><option value="superseded">Superseded</option>
            <option value="cancelled">Cancelled</option><option value="source_held">Source held</option>
            <option value="source_decided">Source decided without a mirrored event</option>
            <option value="unverified">Source unverified</option>
            <option value="all">All statuses</option>
          </select>
        </label>
        {global && <label className="min-w-40 flex-1 text-sm font-medium">Client
          <select value={clientFilter} onChange={(event) => {
            setClientFilter(event.target.value); setPageState({ scopeKey, page: 0 });
          }}
            className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">
            <option value="all">All clients</option>
            {clients.map((id) => <option key={id} value={id}>{id === "agency-wide" ? "Agency-wide" : id}</option>)}
          </select>
        </label>}
        <label className="min-w-40 flex-1 text-sm font-medium">Source type
          <select value={kindFilter} onChange={(event) => {
            setKindFilter(event.target.value); setPageState({ scopeKey, page: 0 });
          }}
            className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">
            <option value="all">All source types</option>
            {kinds.map((kind) => <option key={kind} value={kind}>{kind.replaceAll("_", " ")}</option>)}
          </select>
        </label>
        <label className="min-w-48 flex-[2] text-sm font-medium">Search current page
          <input type="search" value={search} onChange={(event) => {
            setSearch(event.target.value); setSourceDeepLink(null);
            setPageState({ scopeKey, page: 0 });
          }}
            placeholder="Title, source, destination or account"
            className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
        </label>
      </div>

      {!multiClient && !clientId && <p role="alert" className="text-sm text-destructive">Select a client to view approvals.</p>}
      {error && !waiting && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        <p>{error}</p><button type="button" onClick={retry} className="mt-2 underline">Retry</button>
      </div>}
      {decisionError && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{decisionError}</p>}
      {scopeKey && waiting ? <p role="status" className="text-sm text-muted-foreground">Loading canonical requests…</p>
        : error ? null
          : scopeKey ? <>
            <p className="text-sm text-muted-foreground">
              Page {page + 1}: showing {visible.length} of {requests.length} loaded requests.
              {search.trim() ? " Search applies to this page." : ""}
            </p>
            {visible.length === 0 ? <p className="text-sm text-muted-foreground">
              {requests.length === 0 ? page === 0
                ? "No requests have been mirrored yet or match these filters. Check the existing queue tabs for outstanding work."
                : "No requests on this page. Return to the previous page."
                : "No requests match these filters."}
            </p> : <div className="space-y-4">{visible.map((request) => (
              <RequestCard key={request.id} request={request} history={historyByRequest.get(request.id) ?? []}
                clientId={multiClient ? request.client_id ?? "" : clientId ?? ""}
                manager={manager}
                aal={aal} busy={busyId === request.id} onDecide={decide} />
            ))}</div>}
            {(page > 0 || hasNextPage) && <nav aria-label="Approval pages" className="flex items-center gap-3">
              <button type="button" disabled={page === 0 || waiting}
                onClick={() => setPageState({ scopeKey, page: page - 1 })}
                className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50">Previous page</button>
              <span className="text-sm text-muted-foreground">Page {page + 1}</span>
              <button type="button" disabled={!hasNextPage || waiting}
                onClick={() => setPageState({ scopeKey, page: page + 1 })}
                className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50">Next page</button>
            </nav>}
          </> : null}
    </section>
  );
}
