import { useEffect, useState } from "react";
import { Modal } from "../../components/Modal";
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
  archived_name: string | null;
  platform: string;
  display_name: string | null;
  source_hash: string;
  messages: { id: string; direction: string; body: string | null; occurred_at: string }[];
};

function isReviewPacket(value: unknown): value is ReviewPacket {
  if (!value || typeof value !== "object") return false;
  const packet = value as Partial<ReviewPacket>;
  return typeof packet.client_id === "string"
    && typeof packet.conversation_id === "string"
    && typeof packet.source_hash === "string"
    && Array.isArray(packet.messages);
}

export function ArchivedDmReturnsPanel({ clientId }: { clientId: string }) {
  const [rows, setRows] = useState<DueDm[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [review, setReview] = useState<ReviewPacket | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setRows([]);
    setReview(null);
    setError(null);
    setLoading(true);
    void supabase.rpc("list_archived_dm_returns_v11", { p_client_id: clientId })
      .then(({ data, error: readError }) => {
        if (!current) return;
        if (readError || !Array.isArray(data))
          setError("Archived DM returns could not be loaded. Review the owning queue.");
        else setRows(data as DueDm[]);
        setLoading(false);
      }).catch(() => {
        if (!current) return;
        setError("Archived DM returns could not be loaded. Review the owning queue.");
        setLoading(false);
      });
    return () => { current = false; };
  }, [clientId]);

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
      setReview(data);
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
        <ol className="space-y-2">{review.messages.map((message) => <li key={message.id}
          className="rounded border border-border p-2">
          <p className="text-xs text-muted-foreground">{message.direction} · {new Date(message.occurred_at).toLocaleString()}</p>
          <p className="whitespace-pre-wrap">{message.body ?? "[No text body]"}</p>
        </li>)}</ol>
      </div>}
    </Modal>
  </section>;
}
