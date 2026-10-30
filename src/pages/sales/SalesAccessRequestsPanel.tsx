import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { useAuth } from "../../context/auth";
import { supabase } from "../../lib/supabase";

type Member = {
  id: string;
  name: string;
  active: boolean;
  user_id: string | null;
  profiles: { role: string } | null;
};

type AccessRequest = {
  id: string;
  client_id: string;
  member_id: string;
  bound_user_id: string;
  action: string;
  scope_hash: string;
  status: string;
  requested_at: string;
  member_name_snapshot: string | null;
};

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error) return cause.message;
  if (cause && typeof cause === "object" && "message" in cause
    && typeof cause.message === "string") return cause.message;
  return fallback;
}

/** Admin source controls for the exact sales-seat requests mirrored into the Inbox. */
export function SalesAccessRequestsPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const { profile } = useAuth();
  if (profile?.role !== "admin" || !clientId) return null;
  return <SalesAccessRequestsPanelForScope key={`${profile.id}:${clientId}`} clientId={clientId} />;
}

function SalesAccessRequestsPanelForScope({ clientId }: { clientId: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [memberId, setMemberId] = useState("");
  const [action, setAction] = useState<"grant" | "revoke">("grant");
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refreshSequence = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    setLoaded(false);
    setLoadError(null);
    try {
      const [memberResult, requestResult] = await Promise.all([
        supabase.from("team_members")
          .select("id,name,active,user_id,profiles!team_members_user_id_fkey(role)")
          .order("name"),
        supabase.from("client_sales_entitlement_requests")
          .select("id,client_id,member_id,bound_user_id,action,scope_hash,status,requested_at,member_name_snapshot")
          .eq("client_id", clientId)
          .order("requested_at", { ascending: false })
          .limit(50),
      ]);
      if (sequence !== refreshSequence.current) return;
      if (memberResult.error || requestResult.error) {
        throw memberResult.error ?? requestResult.error;
      }
      setMembers((memberResult.data ?? []) as Member[]);
      setRequests((requestResult.data ?? []) as AccessRequest[]);
    } catch (cause) {
      if (sequence === refreshSequence.current) {
        setLoadError(errorMessage(cause, "Could not load sales access requests."));
      }
    } finally {
      if (sequence === refreshSequence.current) setLoaded(true);
    }
  }, [clientId]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void refresh(); });
    return () => { cancelled = true; refreshSequence.current += 1; };
  }, [refresh]);

  const ready = loaded && !loadError;
  const choices = action === "grant"
    ? members.filter((member) => member.active && member.user_id && member.profiles?.role === "employee")
    : members;
  const selected = choices.find((member) => member.id === memberId);
  const pending = requests.find((request) => request.member_id === memberId && request.status === "pending");

  async function submit() {
    if (!ready || !selected || pending || busy) return;
    setBusy(true);
    setActionError(null);
    setCreatedId(null);
    try {
      const result = await supabase.rpc("request_client_sales_entitlement", {
        p_client_id: clientId,
        p_member_id: selected.id,
        p_action: action,
      });
      if (result.error) throw result.error;
      if (typeof result.data !== "string" || !REQUEST_ID.test(result.data)) {
        throw new Error("The request may have been created, but its source ID was not returned. Refresh the request history before trying again.");
      }
      setCreatedId(result.data);
      await refresh();
    } catch (cause) {
      setActionError(errorMessage(cause, "Could not create the sales access request."));
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return <section className="mb-8 rounded-xl border border-border bg-card p-5" aria-labelledby="sales-access-title">
    <h2 id="sales-access-title" className="text-lg font-semibold">Sales access requests</h2>
    <p className="mt-1 text-sm text-muted-foreground">
      Request an exact client, team member, employee account and grant or revoke action for human review in the Approval Inbox.
      Approval requires AAL2. Request history is not proof of current access: the live grant and activation switch are not readable here yet.
    </p>
    {actionError && <p role="alert" className="mt-3 text-sm text-destructive">{actionError}</p>}
    {createdId && <p role="status" className="mt-3 text-sm">
      Request created. <Link className="text-primary underline" to={`/approvals?source=${encodeURIComponent(createdId)}`}>Review its exact version in the Approval Inbox</Link>.
    </p>}
    {!loaded ? <p className="mt-4 text-sm">Loading sales access requests…</p>
      : loadError ? <div className="mt-4" role="alert">
        <p>{loadError}</p>
        <button type="button" className="mt-2 text-primary underline" onClick={() => void refresh()}>Retry</button>
      </div> : <>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-medium">Action
            <select value={action} disabled={busy} onChange={(event) => {
              setAction(event.target.value as "grant" | "revoke");
              setMemberId(""); setActionError(null); setCreatedId(null);
            }} className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2">
              <option value="grant">Request grant</option>
              <option value="revoke">Request revoke</option>
            </select>
          </label>
          <label className="text-sm font-medium">Team member
            <select value={memberId} disabled={busy} onChange={(event) => {
              setMemberId(event.target.value); setActionError(null); setCreatedId(null);
            }} className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2">
              <option value="">Choose a team member</option>
              {choices.map((member) => <option key={member.id} value={member.id}>
                {member.name}{member.active ? "" : " (retired)"} · {member.id}
              </option>)}
            </select>
          </label>
        </div>
        {selected && <p className="mt-3 break-all text-xs text-muted-foreground">
          Exact member ID: {selected.id}. {action === "grant"
            ? `Current linked employee account: ${selected.user_id}. The database will bind and recheck it.`
            : "The database will verify a current grant against its original bound account, including for retired or relinked members."}
        </p>}
        {action === "revoke" && <p className="mt-2 text-xs text-muted-foreground">
          A pending revoke does not suspend an approved grant. Approval in the Inbox completes the revoke.
        </p>}
        {pending && <p role="status" className="mt-3 text-sm">
          This member already has a pending request. <Link className="text-primary underline" to={`/approvals?source=${encodeURIComponent(pending.id)}`}>Review it in the Inbox</Link>.
        </p>}
        <button type="button" disabled={!selected || !!pending || busy} onClick={() => void submit()}
          className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {busy ? "Requesting…" : action === "grant" ? "Request sales access grant" : "Request sales access revoke"}
        </button>
        <div className="mt-6">
          <h3 className="text-sm font-semibold">Recent source requests</h3>
          <p className="mt-1 text-xs text-muted-foreground">Up to 50 recent requests for this client. Status records the decision, not whether access is currently active.</p>
          {requests.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No sales access requests yet.</p>
            : <ul className="mt-2 space-y-2">
              {requests.map((request) => <li key={request.id} className="rounded-lg border border-border p-3 text-sm">
                <span className="font-medium">{request.action === "grant" ? "Grant" : "Revoke"} · {request.member_name_snapshot ?? request.member_id}</span>
                <span className="ml-2">{request.status}</span>
                <p className="mt-1 break-all text-xs text-muted-foreground">Member {request.member_id} · Account {request.bound_user_id} · Scope {request.scope_hash}</p>
                <Link className="mt-1 inline-block text-xs text-primary underline" to={`/approvals?source=${encodeURIComponent(request.id)}`}>Open exact request in Inbox</Link>
              </li>)}
            </ul>}
        </div>
      </>}
  </section>;
}
