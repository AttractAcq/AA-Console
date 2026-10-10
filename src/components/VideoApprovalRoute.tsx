import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

type Account = { id: string; name: string };
type State = {
  owner_user_id: string | null;
  manager_user_id: string | null;
  client_user_id: string | null;
  client_rejection_reason: string | null;
  owner_approved: boolean;
  manager_approved: boolean;
  client_approved: boolean;
  can_configure: boolean;
  current_user_id: string | null;
  client_accounts: Account[];
};

/** Human sign-offs for a finished video, shared by agency and client queues. */
export function VideoApprovalRoute({ assetId, onFinalApprove }: {
  assetId: string;
  onFinalApprove: () => void | Promise<void>;
}) {
  const [state, setState] = useState<State | null>(null);
  const [admins, setAdmins] = useState<Account[]>([]);
  const [ownerChoice, setOwnerChoice] = useState("");
  const [clientChoice, setClientChoice] = useState("");
  const [declineReason, setDeclineReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await supabase.rpc("video_approval_state", { p_asset_id: assetId });
    if (!result) { setError("Approval route unavailable."); return; }
    const { data, error: failure } = result;
    if (failure) { setError(failure.message); return; }
    if (!data) { setError("Approval route unavailable."); return; }
    const next = data as unknown as State;
    setState(next);
    if (next.can_configure) {
      setOwnerChoice(next.owner_user_id ?? "");
      const { data: profiles, error: profileError } = await supabase.from("profiles")
        .select("id, full_name, email").eq("role", "admin").order("full_name");
      if (profileError) { setError(profileError.message); return; }
      setAdmins((profiles ?? []).map((p) => ({ id: p.id, name: p.full_name ?? p.email ?? "Admin" })));
    }
  }, [assetId]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function act(action:
    | { kind: "owner"; userId: string }
    | { kind: "sign"; role: "owner" | "manager" | "client" }
    | { kind: "client"; userId: string }
    | { kind: "decline"; reason: string }) {
    setBusy(true);
    setError(null);
    const result = action.kind === "owner"
      ? await supabase.rpc("set_content_approval_owner", { p_user_id: action.userId })
      : action.kind === "sign"
        ? await supabase.rpc("sign_video_approval", { p_asset_id: assetId, p_role: action.role })
        : action.kind === "client" ? await supabase.rpc("request_video_client_approval", {
          p_asset_id: assetId, p_client_user_id: action.userId,
        }) : await supabase.rpc("decline_video_client_approval", {
          p_asset_id: assetId, p_reason: action.reason,
        });
    const failure = result.error;
    setBusy(false);
    if (failure) { setError(failure.message); return; }
    await refresh();
  }

  if (!state) return <p role={error ? "alert" : undefined}
    className={error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
    {error ?? "Loading approval route…"}</p>;
  const current = state.current_user_id;
  const ready = state.owner_approved && state.manager_approved && !state.client_rejection_reason
    && (!state.client_user_id || state.client_approved);
  const canFinish = current === state.owner_user_id || current === state.manager_user_id;

  return <div className="w-full space-y-2 rounded-md border border-border bg-muted/20 p-2 text-xs">
    <p className="font-medium">Video approval</p>
    <p>Owner: {state.owner_approved ? "approved" : state.owner_user_id ? "waiting" : "not configured"}
      {" · "}SMM: {state.manager_approved ? "approved" : state.manager_user_id ? "waiting" : "not assigned"}
      {state.client_user_id ? ` · Client: ${state.client_rejection_reason ? "changes requested" : state.client_approved ? "approved" : "waiting"}` : ""}
    </p>
    {state.client_rejection_reason && <p className="text-destructive">Client requested changes: {state.client_rejection_reason}</p>}
    {state.can_configure && <div className="flex flex-wrap gap-2">
      <select aria-label="Owner account" value={ownerChoice} onChange={(e) => setOwnerChoice(e.target.value)}
        className="rounded border border-input bg-background px-2 py-1">
        <option value="">Choose owner account…</option>
        {admins.map((admin) => <option key={admin.id} value={admin.id}>{admin.name}</option>)}
      </select>
      <button type="button" disabled={busy || !ownerChoice || ownerChoice === state.owner_user_id}
        onClick={() => void act({ kind: "owner", userId: ownerChoice })}
        className="rounded border border-border px-2 py-1 disabled:opacity-50">Save owner</button>
    </div>}
    <div className="flex flex-wrap gap-2">
      {current === state.owner_user_id && !state.owner_approved && <button type="button" disabled={busy}
        onClick={() => void act({ kind: "sign", role: "owner" })}
        className="rounded border border-border px-2 py-1 disabled:opacity-50">Sign as owner</button>}
      {current === state.manager_user_id && !state.manager_approved && <button type="button" disabled={busy}
        onClick={() => void act({ kind: "sign", role: "manager" })}
        className="rounded border border-border px-2 py-1 disabled:opacity-50">Sign as SMM</button>}
      {current === state.client_user_id && !state.client_approved && !state.client_rejection_reason && <button type="button" disabled={busy}
        onClick={() => void act({ kind: "sign", role: "client" })}
        className="rounded border border-border px-2 py-1 disabled:opacity-50">Sign as client</button>}
    </div>
    {current === state.client_user_id && !state.client_approved && !state.client_rejection_reason &&
      <div className="flex flex-wrap gap-2">
        <input aria-label="Changes needed" value={declineReason} onChange={(e) => setDeclineReason(e.target.value)}
          placeholder="What needs changing?" className="rounded border border-input bg-background px-2 py-1" />
        <button type="button" disabled={busy || !declineReason.trim()}
          onClick={() => void act({ kind: "decline", reason: declineReason.trim() })}
          className="rounded border border-border px-2 py-1 disabled:opacity-50">Request changes</button>
      </div>}
    {current === state.manager_user_id && (!state.client_user_id || state.client_rejection_reason) && state.client_accounts.length > 0 &&
      <div className="flex flex-wrap gap-2">
        <select aria-label="Client approver" value={clientChoice} onChange={(e) => setClientChoice(e.target.value)}
          className="rounded border border-input bg-background px-2 py-1">
          <option value="">Choose client approver…</option>
          {state.client_accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
        </select>
        <button type="button" disabled={busy || !(clientChoice || state.client_user_id)}
          onClick={() => void act({ kind: "client", userId: clientChoice || state.client_user_id! })}
          className="rounded border border-border px-2 py-1 disabled:opacity-50">Request client sign-off</button>
      </div>}
    {ready && canFinish && <button type="button" disabled={busy}
      onClick={() => void onFinalApprove()}
      className="rounded bg-primary px-2 py-1 font-medium text-primary-foreground disabled:opacity-50">Final approve</button>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </div>;
}
