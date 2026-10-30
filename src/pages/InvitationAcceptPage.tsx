import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../context/auth";
import { callRuntime } from "../lib/callRuntime";

type InvitationPreview = {
  recipientEmail: string;
  targetRole: "employee" | "client";
  fullName: string;
  teamCategory: string | null;
  status: string;
};

export function InvitationAcceptPage() {
  const [params] = useSearchParams();
  const requestId = params.get("request") ?? "";
  const { session, loading } = useAuth();
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    if (!session || !requestId) return;
    let cancelled = false;
    void callRuntime<{ invitation: InvitationPreview }>("/admin/invitations/inspect", { requestId })
      .then((result) => { if (!cancelled) setPreview(result.invitation); })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not inspect invitation.");
      });
    return () => { cancelled = true; };
  }, [session, requestId]);

  async function accept() {
    if (!preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      await callRuntime("/admin/invitations/accept", { requestId });
      setAccepted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not accept invitation.");
    } finally {
      setBusy(false);
    }
  }

  const destination = preview?.targetRole === "client" ? "/client/dashboard" : "/employee/dashboard";
  return <main className="mx-auto max-w-lg p-6">
    <h1 className="text-2xl font-semibold">AA Console invitation</h1>
    {!requestId && <p role="alert" className="mt-4">This invitation link is incomplete.</p>}
    {requestId && loading && <p className="mt-4">Checking your Auth session…</p>}
    {requestId && !loading && !session && <p className="mt-4">Open the invitation email link to sign in to the invited Auth account.</p>}
    {error && <p role="alert" className="mt-4 text-destructive">{error}</p>}
    {preview && <section className="mt-4 rounded border border-border p-4">
      <p>Recipient: <strong>{preview.recipientEmail}</strong></p>
      <p>Role: <strong>{preview.targetRole}</strong></p>
      <p>Name: <strong>{preview.fullName}</strong></p>
      {preview.teamCategory && <p>Team: <strong>{preview.teamCategory}</strong></p>}
      {accepted || preview.status === "accepted" ? (
        <p className="mt-4" role="status">Invitation accepted. <a className="text-brand-strong underline" href={destination}>Open your console</a></p>
      ) : (
        <button type="button" disabled={busy} onClick={() => void accept()}
          className="mt-4 rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">
          {busy ? "Accepting…" : "Accept invitation and create my console access"}
        </button>
      )}
    </section>}
  </main>;
}
