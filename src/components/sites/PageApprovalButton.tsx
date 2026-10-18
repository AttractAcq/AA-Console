import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { callRuntime } from "../../lib/callRuntime";

export function PageApprovalButton({ pageId, ready }: { pageId: string; ready: boolean }) {
  const { clientId } = useParams<{ clientId: string }>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function requestApproval() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await callRuntime<{ destination: string; status: string }>(
        "/admin/sites/request-page-approval", { pageId });
      setNotice(`Review requested for ${result.destination}. Publication remains blocked until the approved-version executor is connected.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not request page approval.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="space-y-2 text-xs">
    <button type="button" disabled={!ready || busy} onClick={() => void requestApproval()}
      className="rounded-md border border-border px-2.5 py-1 font-medium text-card-foreground hover:bg-accent disabled:opacity-50">
      {busy ? "Preparing review…" : "Request page review"}
    </button>
    {!ready && <p className="text-muted-foreground">Build the page and provision a ready site before review.</p>}
    <p className="text-muted-foreground">V6 campaign pages need exact-version human approval before deployment.</p>
    {clientId && <Link to={`/clients/${clientId}/delivery/approval-inbox`} className="text-primary underline">Open Approval Inbox</Link>}
    {notice && <p role="status" className="text-brand-strong">{notice}</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </div>;
}
