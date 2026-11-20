import { useEffect, useState } from "react";
import { Modal } from "../../components/Modal";
import { FormModal } from "../../components/forms/FormModal";
import { supabase } from "../../lib/supabase";

type DueDm = {
  conversation_id: string;
  archived_lead_id: string;
  platform: string;
  display_name: string | null;
  last_inbound_at: string | null;
  unread_inbound: number;
};

type ReviewPacket = {
  client_id: string;
  conversation_id: string;
  archived_lead_id: string;
  archived_name: string | null;
  platform: string;
  display_name: string | null;
  source_hash: string;
  messages: { id: string; direction: string; body: string | null; occurred_at: string }[];
  canDecide?: boolean;
};

type GroupPacket = {
  client_id: string;
  archived_lead_id: string;
  source_count: number;
  dm_count: number;
};

function isReviewPacket(value: unknown): value is ReviewPacket {
  if (!value || typeof value !== "object") return false;
  const packet = value as Partial<ReviewPacket>;
  return typeof packet.client_id === "string"
    && typeof packet.conversation_id === "string"
    && typeof packet.archived_lead_id === "string"
    && typeof packet.source_hash === "string"
    && Array.isArray(packet.messages);
}

function isGroupPacket(value: unknown): value is GroupPacket {
  if (!value || typeof value !== "object") return false;
  const packet = value as Partial<GroupPacket>;
  return typeof packet.client_id === "string"
    && typeof packet.archived_lead_id === "string"
    && typeof packet.source_count === "number"
    && typeof packet.dm_count === "number";
}

export function ArchivedDmReturnsPanel({ clientId }: { clientId: string }) {
  const [rows, setRows] = useState<DueDm[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [review, setReview] = useState<ReviewPacket | null>(null);
  const [decision, setDecision] = useState<ReviewPacket | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let current = true;
    setRows([]);
    setReview(null);
    setDecision(null);
    setError(null);
    setLoading(true);
    void (async () => {
      try {
        const { data, error: readError } = await supabase.rpc(
          "list_archived_dm_returns_v11", { p_client_id: clientId },
        );
        if (!current) return;
        if (readError || !Array.isArray(data))
          setError("Archived DM returns could not be loaded. Review the owning queue.");
        else setRows(data as DueDm[]);
      } catch {
        if (!current) return;
        setError("Archived DM returns could not be loaded. Review the owning queue.");
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => { current = false; };
  }, [clientId, reload]);

  async function openReview(conversationId: string) {
    setOpening(conversationId);
    setError(null);
    try {
      const { data, error: readError } = await supabase.rpc(
        "archived_dm_return_review_packet_v11",
        { p_conversation_id: conversationId },
      );
      if (readError || !isReviewPacket(data) || data.client_id !== clientId
        || data.conversation_id !== conversationId) {
        setError("The exact DM review could not be loaded. Refresh and try again.");
        return;
      }
      const { data: groupData, error: groupError } = await supabase.rpc(
        "archived_return_batch_review_packet_v11",
        { p_archived_lead_id: data.archived_lead_id },
      );
      if (groupError || !isGroupPacket(groupData)
        || groupData.client_id !== clientId
        || groupData.archived_lead_id !== data.archived_lead_id) {
        setError("Related identity arrivals could not be checked. Review remains held.");
        return;
      }
      setReview({ ...data, canDecide: groupData.source_count === 0 && groupData.dm_count === 1 });
    } catch {
      setError("The exact DM review could not be loaded. Refresh and try again.");
    } finally {
      setOpening(null);
    }
  }

  return <section aria-label="Archived DM returns" className="mb-5 rounded-lg border border-border bg-card p-4">
    <h2 className="text-sm font-semibold text-foreground">Archived DM returns</h2>
    <p className="mt-1 text-xs text-muted-foreground">
      Inbound messages are retained while the archived identity stays closed. Review here is read only;
      it does not reopen a lead or authorize a reply.
    </p>
    {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    {loading ? <p className="mt-2 text-sm text-muted-foreground">Loading DM returns…</p>
      : rows.length === 0 && !error ? <p className="mt-2 text-sm text-muted-foreground">No held DM returns.</p>
        : <ul className="mt-3 space-y-2">{rows.map((row) => <li key={row.conversation_id}
          className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-3 text-sm">
          <span>{row.display_name ?? "Unnamed sender"} · {row.platform} · {row.unread_inbound} unread
            {row.last_inbound_at ? ` · ${new Date(row.last_inbound_at).toLocaleString()}` : ""}</span>
          <button type="button" disabled={opening !== null} onClick={() => void openReview(row.conversation_id)}
            className="rounded text-brand-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {opening === row.conversation_id ? "Opening…" : "View exact messages"}
          </button>
        </li>)}</ul>}
    <Modal open={review !== null} onClose={() => setReview(null)} title="Archived DM identity review">
      {review && <div className="space-y-3 text-sm">
        <p>Archived contact: {review.archived_name ?? "Unnamed"} · {review.display_name ?? "Unnamed sender"} · {review.platform}.</p>
        <p className="text-muted-foreground">This exact source version is held for an AAL2 identity decision. No reply is sent from this view.</p>
        {!review.canDecide && <p role="status" className="text-muted-foreground">
          Related form, sales-agent or DM arrivals need one coordinated review. This individual decision is held.
        </p>}
        <ol className="space-y-2">{review.messages.map((message) => <li key={message.id}
          className="rounded border border-border p-2">
          <p className="text-xs text-muted-foreground">{message.direction} · {new Date(message.occurred_at).toLocaleString()}</p>
          <p className="whitespace-pre-wrap">{message.body ?? "[No text body]"}</p>
        </li>)}</ol>
        {review.canDecide && <button type="button"
          onClick={() => { setDecision(review); setReview(null); }}
          className="rounded border border-border px-3 py-2 font-medium text-brand-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Record AAL2 identity decision
        </button>}
      </div>}
    </Modal>
    <FormModal open={decision !== null} onClose={() => setDecision(null)}
      title="Decide archived DM identity" submitLabel="Record AAL2 decision"
      intro={decision && <div className="space-y-2 text-sm">
        <p>Archived contact: {decision.archived_name ?? "Unnamed"} · {decision.display_name ?? "Unnamed sender"}.</p>
        <p>Reopening preserves the historical lead. A separate lead preserves the archive. The DM stays closed and no reply is sent.</p>
        <ol className="max-h-40 space-y-1 overflow-y-auto">{decision.messages.map((message) => <li key={message.id}
          className="rounded border border-border p-2">{message.direction}: {message.body ?? "[No text body]"}</li>)}</ol>
      </div>}
      fields={[
        { name: "action", label: "Reviewed outcome", kind: "select", required: true,
          options: [
            { value: "recover", label: "Reopen archived lead" },
            { value: "new_lead", label: "Start separate lead" },
          ] },
        { name: "reason", label: "Reason for this decision", kind: "textarea", required: true,
          rows: 3, hint: "Explain why the DM continues the old relationship or starts a new one." },
      ]}
      onSubmit={async (values) => {
        if (!decision) throw new Error("The exact DM packet is unavailable.");
        const action = String(values.action);
        if (action !== "recover" && action !== "new_lead")
          throw new Error("Choose a reviewed outcome.");
        const { data, error: decisionError } = await supabase.rpc(
          "resolve_archived_dm_return_v11", {
            p_conversation_id: decision.conversation_id,
            p_action: action,
            p_expected_hash: decision.source_hash,
            p_reason: String(values.reason ?? "").trim(),
          },
        );
        if (decisionError) throw new Error(decisionError.message);
        if (!data) throw new Error("The DM identity decision did not complete.");
      }}
      onSaved={() => { setDecision(null); setReload((value) => value + 1); }} />
  </section>;
}
