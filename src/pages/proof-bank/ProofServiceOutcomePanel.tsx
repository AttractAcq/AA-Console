import { useCallback, useEffect, useState } from "react";
import { FormModal } from "../../components/forms/FormModal";
import { supabase } from "../../lib/supabase";

type Lead = { id: string; name: string | null; stage: string };
type Outcome = {
  id: string; lead_id: string; outcome_summary: string; occurred_at: string;
  evidence_source: string; evidence_note: string; evidence_url: string | null;
  verified_at: string | null; withdrawn_at: string | null;
};

export function ProofServiceOutcomePanel({ clientId, onChange }: {
  clientId: string; onChange?: () => void;
}) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [create, setCreate] = useState(false);
  const [withdraw, setWithdraw] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const [l, o] = await Promise.all([
      supabase.from("client_leads").select("id,name,stage")
        .eq("client_id", clientId).in("stage", ["sale", "cash"])
        .order("stage_at", { ascending: false }).limit(100),
      supabase.from("proof_service_outcomes_v7")
        .select("id,lead_id,outcome_summary,occurred_at,evidence_source,evidence_note,evidence_url,verified_at,withdrawn_at")
        .eq("client_id", clientId).order("recorded_at", { ascending: false }).limit(100),
    ]);
    setError(l.error?.message ?? o.error?.message ?? null);
    if (!l.error) setLeads(l.data ?? []);
    if (!o.error) setOutcomes(o.data ?? []);
  }, [clientId]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function verify(id: string) {
    setBusy(id); setError(null);
    const { data: auth, error: authError } = await supabase.auth.getUser();
    if (authError || !auth.user) { setError("Sign in again."); setBusy(null); return; }
    const { error: updateError } = await supabase.from("proof_service_outcomes_v7")
      .update({ verified_by: auth.user.id, verified_at: new Date().toISOString() })
      .eq("id", id).eq("client_id", clientId).is("verified_at", null).is("withdrawn_at", null);
    setBusy(null);
    if (updateError) { setError(updateError.message); return; }
    await refresh(); onChange?.();
  }

  return <section className="space-y-3 rounded-lg border border-border bg-card p-4">
    <h3 className="font-semibold">Service outcome evidence</h3>
    <p className="text-sm text-muted-foreground">Record what was completed and where the evidence came from. An AAL2 reviewer verifies the record before an outcome follow-up can be prepared. Verification does not clear any customer proof for publication.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <button type="button" className="rounded-md border border-border px-3 py-2 text-sm"
      onClick={() => setCreate(true)}>Record service outcome</button>
    {outcomes.map((outcome) => <article key={outcome.id} className="rounded-md border border-border p-3 text-sm">
      <p className="font-medium">{leads.find((lead) => lead.id === outcome.lead_id)?.name ?? "Lead unavailable"} · {outcome.outcome_summary}</p>
      <p className="text-xs text-muted-foreground">{outcome.withdrawn_at ? "Withdrawn" : outcome.verified_at ? "Verified" : "Awaiting verification"} · occurred {new Date(outcome.occurred_at).toLocaleString()}</p>
      <details className="mt-1"><summary>Source evidence</summary>
        <p className="mt-1">{outcome.evidence_source}</p>
        <p className="mt-1 whitespace-pre-wrap">{outcome.evidence_note}</p>
        {outcome.evidence_url && <a className="underline" href={outcome.evidence_url} target="_blank" rel="noreferrer">Open source</a>}
      </details>
      {!outcome.verified_at && !outcome.withdrawn_at && <button type="button"
        disabled={busy !== null} className="mt-2 rounded-md border border-border px-3 py-2 disabled:opacity-50"
        onClick={() => void verify(outcome.id)}>{busy === outcome.id ? "Verifying…" : "Verify evidence"}</button>}
      {!outcome.withdrawn_at && <button type="button" className="mt-2 ml-2 rounded-md border border-border px-3 py-2"
        onClick={() => setWithdraw(outcome.id)}>Withdraw outcome</button>}
    </article>)}
    <FormModal open={create} onClose={() => setCreate(false)} title="Record service outcome"
      submitLabel="Record for verification" fields={[
        { name: "leadId", label: "Customer with recorded sale", kind: "select", required: true,
          options: leads.map((lead) => ({ value: lead.id, label: `${lead.name ?? "Unnamed lead"} · ${lead.stage}` })) },
        { name: "summary", label: "Specific completed outcome", kind: "textarea", required: true, rows: 3 },
        { name: "occurredAt", label: "Completion date and time (ISO)", kind: "text", required: true },
        { name: "source", label: "Evidence source or record reference", kind: "text", required: true },
        { name: "note", label: "What the evidence confirms", kind: "textarea", required: true, rows: 3 },
        { name: "url", label: "Source URL (optional)", kind: "text" },
      ]} initialValues={{ occurredAt: new Date().toISOString() }}
      onSubmit={async (values) => {
        const { data: auth, error: authError } = await supabase.auth.getUser();
        if (authError || !auth.user) throw new Error("Sign in again.");
        const { error: insertError } = await supabase.from("proof_service_outcomes_v7")
          .insert({ client_id: clientId, lead_id: String(values.leadId),
            outcome_summary: String(values.summary).trim(), occurred_at: String(values.occurredAt),
            evidence_source: String(values.source).trim(), evidence_note: String(values.note).trim(),
            evidence_url: String(values.url ?? "").trim() || null, recorded_by: auth.user.id });
        if (insertError) throw insertError;
      }} onSaved={() => { void refresh(); onChange?.(); }} />
    <FormModal open={withdraw !== null} onClose={() => setWithdraw(null)} title="Withdraw service outcome"
      submitLabel="Withdraw outcome" fields={[
        { name: "reason", label: "Why this outcome is no longer verified", kind: "textarea", required: true, rows: 3 },
      ]} onSubmit={async (values) => {
        if (!withdraw) return;
        const { error: updateError } = await supabase.from("proof_service_outcomes_v7")
          .update({ withdrawn_at: new Date().toISOString(), withdrawal_reason: String(values.reason).trim() })
          .eq("id", withdraw).eq("client_id", clientId).is("withdrawn_at", null);
        if (updateError) throw updateError;
      }} onSaved={() => { void refresh(); onChange?.(); }} />
  </section>;
}
