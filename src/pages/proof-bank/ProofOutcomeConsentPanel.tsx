import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { FormModal } from "../../components/forms/FormModal";

type Lead = { id: string; name: string | null; stage: string; email: string | null; phone: string | null };
type Consent = {
  id: string; lead_id: string; channel: string; recipient: string;
  consent_text: string; evidence_note: string; consented_at: string;
  withdrawn_at: string | null;
};

export function ProofOutcomeConsentPanel({ clientId, onChange }: {
  clientId: string; onChange?: () => void;
}) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [consents, setConsents] = useState<Consent[]>([]);
  const [create, setCreate] = useState(false);
  const [withdraw, setWithdraw] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const [l, c] = await Promise.all([
      supabase.from("client_leads").select("id,name,stage,email,phone")
        .eq("client_id", clientId).in("stage", ["sale", "cash"])
        .order("stage_at", { ascending: false }).limit(100),
      supabase.from("proof_outcome_followup_consents_v7")
        .select("id,lead_id,channel,recipient,consent_text,evidence_note,consented_at,withdrawn_at")
        .eq("client_id", clientId).order("recorded_at", { ascending: false }).limit(100),
    ]);
    setError(l.error?.message ?? c.error?.message ?? null);
    if (!l.error) setLeads(l.data ?? []);
    if (!c.error) setConsents(c.data ?? []);
  }, [clientId]);
  useEffect(() => { void refresh(); }, [refresh]);

  return <section className="space-y-3 rounded-lg border border-border bg-card p-4">
    <h3 className="font-semibold">Outcome and consent evidence</h3>
    <p className="text-sm text-muted-foreground">Record the customer’s specific permission to receive a proof follow-up. A sale and ordinary lead-intake consent alone do not authorize a request. Each message still needs exact Inbox approval.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <button type="button" className="rounded-md border border-border px-3 py-2 text-sm"
      onClick={() => setCreate(true)}>Record follow-up consent</button>
    {leads.length === 0 && <p className="text-sm text-muted-foreground">No recorded sale or cash-stage leads are available.</p>}
    {consents.map((consent) => <article key={consent.id} className="rounded-md border border-border p-3 text-sm">
      <p className="font-medium">{leads.find((lead) => lead.id === consent.lead_id)?.name ?? "Lead unavailable"} · {consent.channel} · {consent.recipient}</p>
      <p className="text-xs text-muted-foreground">{consent.withdrawn_at ? "Withdrawn" : "Recorded"} · consented {new Date(consent.consented_at).toLocaleString()}</p>
      <details className="mt-1"><summary>Consent and evidence</summary>
        <p className="mt-1 whitespace-pre-wrap">{consent.consent_text}</p>
        <p className="mt-1 whitespace-pre-wrap">{consent.evidence_note}</p>
      </details>
      {!consent.withdrawn_at && <button type="button" className="mt-2 rounded-md border border-border px-3 py-2"
        onClick={() => setWithdraw(consent.id)}>Withdraw consent</button>}
    </article>)}
    <FormModal open={create} onClose={() => setCreate(false)} title="Record proof follow-up consent"
      submitLabel="Record consent" fields={[
        { name: "leadId", label: "Customer with recorded sale", kind: "select", required: true,
          options: leads.map((lead) => ({ value: lead.id, label: `${lead.name ?? "Unnamed lead"} · ${lead.stage}` })) },
        { name: "channel", label: "Permitted channel", kind: "select", required: true,
          options: [{ value: "email", label: "Email" }, { value: "sms", label: "SMS" }, { value: "whatsapp", label: "WhatsApp" }] },
        { name: "consentText", label: "Exact words the customer agreed to", kind: "textarea", required: true, rows: 3 },
        { name: "evidenceNote", label: "Where and how consent was obtained", kind: "textarea", required: true, rows: 3 },
        { name: "evidenceUrl", label: "Evidence URL (optional)", kind: "text" },
        { name: "consentedAt", label: "Consent date and time (ISO)", kind: "text", required: true },
      ]} initialValues={{ channel: "email", consentedAt: new Date().toISOString() }}
      onSubmit={async (values) => {
        const lead = leads.find((item) => item.id === values.leadId);
        const channel = String(values.channel);
        const recipient = channel === "email" ? lead?.email : lead?.phone;
        if (!lead || !recipient) throw new Error("The selected lead has no contact for that channel.");
        const { data: auth, error: authError } = await supabase.auth.getUser();
        if (authError || !auth.user) throw new Error("Sign in again.");
        const { error: insertError } = await supabase.from("proof_outcome_followup_consents_v7")
          .insert({ client_id: clientId, lead_id: lead.id, channel, recipient,
            consent_text: String(values.consentText).trim(), evidence_note: String(values.evidenceNote).trim(),
            evidence_url: String(values.evidenceUrl ?? "").trim() || null,
            consented_at: String(values.consentedAt), recorded_by: auth.user.id });
        if (insertError) throw insertError;
      }} onSaved={() => { void refresh(); onChange?.(); }} />
    <FormModal open={withdraw !== null} onClose={() => setWithdraw(null)} title="Withdraw proof follow-up consent"
      submitLabel="Withdraw consent" fields={[
        { name: "reason", label: "Withdrawal reason", kind: "textarea", required: true, rows: 3 },
      ]} onSubmit={async (values) => {
        if (!withdraw) return;
        const { error: updateError } = await supabase.from("proof_outcome_followup_consents_v7")
          .update({ withdrawn_at: new Date().toISOString(), withdrawal_reason: String(values.reason).trim() })
          .eq("id", withdraw).eq("client_id", clientId).is("withdrawn_at", null);
        if (updateError) throw updateError;
      }} onSaved={() => { void refresh(); onChange?.(); }} />
  </section>;
}
