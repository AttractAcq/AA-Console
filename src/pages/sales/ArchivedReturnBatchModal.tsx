import { useState, type FormEvent } from "react";
import { Modal } from "../../components/Modal";
import { resolveArchivedReturnBatch, type ArchivedReturnBatchPacket } from "../../lib/archivedReturnBatch";

export function ArchivedReturnBatchModal({ packet, onClose, onSaved }: {
  packet: ArchivedReturnBatchPacket | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  return <Modal open={packet !== null} onClose={onClose} title="Related archived-contact arrivals">
    {packet && <BatchReview key={packet.source_hash} packet={packet} onSaved={onSaved} />}
  </Modal>;
}

function BatchReview({ packet, onSaved }: {
  packet: ArchivedReturnBatchPacket;
  onSaved: () => void;
}) {
  const [action, setAction] = useState<"recover" | "new_lead">("recover");
  const [primary, setPrimary] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canDecide = packet.source_count >= 2 && packet.dm_count === 0;
  const choices = packet.sources.map((source) => ({
    value: `${source.kind}:${source.submission_id ?? source.conversation_id}`,
    label: `${source.kind === "form" ? "Form" : "Sales agent"}: ${source.submitted_name
      ?? source.current_name ?? source.submitted_email ?? source.current_email
      ?? source.submission_id ?? source.conversation_id}`,
  }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canDecide || busy) return;
    const selected = choices.find((choice) => choice.value === primary);
    if (action === "new_lead" && !selected) {
      setError("Choose which arrival is the primary source of the new lead.");
      return;
    }
    const [primaryKind, primaryId] = selected?.value.split(":") ?? [];
    setBusy(true);
    setError(null);
    try {
      await resolveArchivedReturnBatch({
        archivedLeadId: packet.archived_lead_id,
        action,
        sourceHash: packet.source_hash,
        reason,
        primaryKind: action === "new_lead" ? primaryKind as "form" | "sales_agent" : null,
        primaryId: action === "new_lead" ? primaryId ?? null : null,
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The grouped review could not be recorded.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="space-y-4 text-sm">
      <p>Archived record: {packet.archived_name ?? packet.archived_lead_id}.</p>
      <p role="status" className="rounded border border-border bg-muted/40 p-3">
        {packet.blocker}
      </p>
      <p>{packet.source_count} form or sales-agent arrival{packet.source_count === 1 ? "" : "s"}
        {" · "}{packet.dm_count} held DM conversation{packet.dm_count === 1 ? "" : "s"}.</p>
      {packet.sources.length > 0 && <ul className="space-y-2">
        {packet.sources.map((source) => <li key={`${source.kind}:${source.submission_id ?? source.conversation_id}`}
          className="rounded border border-border p-3">
          <strong>{source.kind === "form" ? "Form submission" : "Sales-agent conversation"}</strong>
          <span className="block">{source.submitted_name ?? source.current_name
            ?? source.submitted_email ?? source.current_email
            ?? source.submitted_phone ?? source.current_phone ?? "Contact unknown"}</span>
          {source.kind === "form" ? <div className="mt-1 space-y-1 text-muted-foreground">
            <p>Contact: {source.submitted_email ?? source.submitted_phone ?? "unknown"}.</p>
            <p>Consent: {source.consent_wording ?? "missing"}.</p>
            <p>Captured source: {source.source_snapshot?.source_channel
              ?? source.source_snapshot?.purpose ?? "unknown"}; route
              {" "}{source.route_package_id ?? "unknown"}; click {source.click_id ?? "unknown"}.</p>
          </div> : <div className="mt-1 space-y-1 text-muted-foreground">
            <p>Match-time contact: {source.matched?.contact_name ?? "unknown"} ·
              {" "}{source.matched?.contact_email ?? source.matched?.contact_phone ?? "no contact"}.</p>
            <p>Current contact: {source.current_name ?? "unknown"} ·
              {" "}{source.current_email ?? source.current_phone ?? "no contact"}.</p>
            <p>Match-time outcome: {source.matched?.outcome ?? "unknown"}; current outcome
              {" "}{source.current_outcome ?? "unknown"}.</p>
            <p>Matched transcript: <code className="break-all">{source.matched?.transcript_sha256 ?? "unknown"}</code>.</p>
          </div>}
          <p className="mt-1 text-xs text-muted-foreground">Exact source: <code className="break-all">
            {source.source_hash ?? "unknown"}</code></p>
        </li>)}
      </ul>}
      {packet.dms.length > 0 && <ul className="space-y-2">
        {packet.dms.map((dm) => <li key={dm.conversation_id} className="rounded border border-border p-3">
          Held {dm.platform} DM · last inbound {dm.last_inbound_at ?? "unknown"}
        </li>)}
      </ul>}
      {canDecide ? <form onSubmit={(event) => void submit(event)} className="space-y-3">
        <p>One AAL2 decision applies to every listed form and sales-agent arrival.</p>
        <p className="text-xs text-muted-foreground">Reviewed batch: <code className="break-all">
          {packet.source_hash}</code></p>
        <label className="block space-y-1">
          <span>Reviewed outcome</span>
          <select className="w-full rounded border border-border bg-card p-2" value={action}
            onChange={(event) => setAction(event.target.value as "recover" | "new_lead")}>
            <option value="recover">Reopen archived lead for all arrivals</option>
            <option value="new_lead">Start one separate lead for all arrivals</option>
          </select>
        </label>
        {action === "new_lead" && <label className="block space-y-1">
          <span>Primary source for attribution</span>
          <select className="w-full rounded border border-border bg-card p-2" value={primary}
            required onChange={(event) => setPrimary(event.target.value)}>
            <option value="">Choose one arrival</option>
            {choices.map((choice) => <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>)}
          </select>
        </label>}
        <label className="block space-y-1">
          <span>Reason for this decision</span>
          <textarea className="w-full rounded border border-border bg-card p-2" value={reason}
            required minLength={8} maxLength={2000} rows={3}
            onChange={(event) => setReason(event.target.value)} />
        </label>
        {error && <p role="alert" className="text-destructive">{error}</p>}
        <button type="submit" disabled={busy}
          className="rounded bg-brand px-3 py-2 text-white disabled:opacity-50">
          {busy ? "Recording…" : "Record grouped AAL2 decision"}
        </button>
      </form> : <p className="text-muted-foreground">
        This overview is read-only while a DM or other unsupported arrival needs review.
      </p>}
    </div>;
}
