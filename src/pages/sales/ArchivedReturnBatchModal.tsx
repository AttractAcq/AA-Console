import { Modal } from "../../components/Modal";
import type { ArchivedReturnBatchPacket } from "../../lib/archivedReturnBatch";

export function ArchivedReturnBatchModal({ packet, onClose }: {
  packet: ArchivedReturnBatchPacket | null;
  onClose: () => void;
}) {
  return <Modal open={packet !== null} onClose={onClose} title="Related archived-contact arrivals">
    {packet && <div className="space-y-4 text-sm">
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
        </li>)}
      </ul>}
      {packet.dms.length > 0 && <ul className="space-y-2">
        {packet.dms.map((dm) => <li key={dm.conversation_id} className="rounded border border-border p-3">
          Held {dm.platform} DM · last inbound {dm.last_inbound_at ?? "unknown"}
        </li>)}
      </ul>}
      <p className="text-muted-foreground">This is a read-only overview. No lead is reopened or created here.</p>
    </div>}
  </Modal>;
}
