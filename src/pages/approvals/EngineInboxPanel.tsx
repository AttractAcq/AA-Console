import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";

import { Modal } from "../../components/Modal";
import { signPaths } from "../../lib/media";
import { supabase } from "../../lib/supabase";
import { cn } from "../../lib/cn";
import {
  inboxCard,
  inboxOrder,
  type Finding,
  type InboxCard,
  type InboxRow,
  type Urgency,
} from "../../lib/approvalInbox";

/**
 * The one human commit, as a screen.
 *
 * M4 put approve_slot, reject_slot and regenerate_slot in the database and
 * nothing called any of them. The engine could plan a slot, pick an idea,
 * brief it, build it, write its copy and pass its own QA, and then stop
 * forever — because the only thing that could finish it was a SQL prompt.
 *
 * Deliberately separate from the Approvals panel beside it. That one calls
 * review_media_asset, which signs off an asset and moves nothing: an
 * engine-made asset approved there is approved and still never reaches a
 * calendar, which is the exact fault M4 was written to fix. So the two
 * queues do not overlap, and the asset panel sends engine work here.
 *
 * Three acts, three buttons, and rejecting asks why. The reason is what the
 * engine writes the next attempt from, so reject_slot refuses an empty one
 * and this does not offer to send it.
 */

const URGENCY_TONE: Record<Urgency, string> = {
  overdue: "border-destructive/50 bg-destructive/5",
  soon: "border-border bg-card",
  later: "border-border bg-card",
};

const URGENCY_TEXT: Record<Urgency, string> = {
  overdue: "text-destructive",
  soon: "text-foreground",
  later: "text-muted-foreground",
};

/** A rejected slot, which is the only thing regenerate_slot accepts. */
interface RejectedRow {
  id: string;
  platform: string;
  format: string | null;
  scheduled_at: string;
  blocked_reason: string | null;
  attempts: number | null;
  idea_id: string | null;
}

function findingList(label: string, findings: Finding[], tone: string) {
  if (findings.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className={cn("text-xs font-medium", tone)}>{label}</p>
      <ul className="space-y-0.5">
        {findings.map((finding, i) => (
          <li key={i} className="text-xs text-muted-foreground">
            {[finding.area, finding.detail].filter(Boolean).join(" — ")}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function EngineInboxPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [rejected, setRejected] = useState<RejectedRow[]>([]);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<InboxCard | null>(null);
  const [reason, setReason] = useState("");

  const refresh = useCallback(async () => {
    if (!clientId) {
      setRows([]);
      setRejected([]);
      setLoading(false);
      return;
    }
    setLoadError(null);
    try {
      const [inbox, rejects] = await Promise.all([
        supabase.from("approval_inbox").select("*").eq("client_id", clientId),
        supabase
          .from("content_slots")
          .select("id, platform, format, scheduled_at, blocked_reason, attempts, idea_id")
          .eq("client_id", clientId)
          .eq("stage", "rejected")
          .order("scheduled_at"),
      ]);
      if (inbox.error) throw inbox.error;
      if (rejects.error) throw rejects.error;

      const inboxRows = (inbox.data ?? []) as InboxRow[];
      setRows(inboxRows);
      setRejected((rejects.data ?? []) as RejectedRow[]);

      // The asset is the thing being approved, so the card has to show it.
      const assetIds = inboxRows.map((r) => r.asset_id).filter((id): id is string => Boolean(id));
      if (assetIds.length > 0) {
        const { data: assets } = await supabase
          .from("client_media_assets")
          .select("id, storage_path, render_path")
          .in("id", assetIds);
        const paths = (assets ?? []).map(
          (a) => (a as { render_path?: string | null; storage_path?: string | null }).render_path ??
            (a as { storage_path?: string | null }).storage_path ??
            "",
        );
        const signed = await signPaths("client-media", paths);
        setUrls(
          new Map(
            (assets ?? []).flatMap((a) => {
              const row = a as { id: string; render_path?: string | null; storage_path?: string | null };
              const url = signed.get(row.render_path ?? row.storage_path ?? "");
              return url ? [[row.id, url] as [string, string]] : [];
            }),
          ),
        );
      } else {
        setUrls(new Map());
      }
    } catch (cause) {
      setLoadError(
        (cause as { message?: string }).message ?? "Could not load what is waiting for a person.",
      );
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const cards = useMemo(() => inboxOrder(rows.map(inboxCard)), [rows]);

  async function act(
    fn: "approve_slot" | "reject_slot" | "regenerate_slot",
    slotId: string,
    args: Record<string, unknown> = {},
  ) {
    setBusy(slotId);
    setError(null);
    const { error: failure } = await supabase.rpc(fn, { p_slot_id: slotId, ...args });
    setBusy(null);
    if (failure) {
      setError(failure.message);
      return;
    }
    await refresh();
  }

  if (loadError) {
    return (
      <div role="alert" className="space-y-2">
        <p className="text-sm text-destructive">{loadError}</p>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent"
        >
          Retry
        </button>
      </div>
    );
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading what is waiting…</p>;

  return (
    <div className="space-y-6">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {cards.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing is waiting on a person. The engine stops here, so an empty queue means either it
          has caught up or it is not running.
        </p>
      ) : (
        <ul className="space-y-4">
          {cards.map((card) => (
            <li
              key={card.slotId}
              className={cn("rounded-lg border p-4", URGENCY_TONE[card.urgency])}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-foreground">{card.assetTitle}</p>
                  <p className="text-xs text-muted-foreground">
                    {[card.platform, card.format, card.pillarName].filter(Boolean).join(" · ")}
                  </p>
                  <p className={cn("text-xs", URGENCY_TEXT[card.urgency])}>
                    {card.due} · {card.waited}
                  </p>
                </div>
                <div className="text-right text-xs text-muted-foreground">
                  <p>
                    QA{" "}
                    <span className="font-medium text-foreground">
                      {card.qaScore === null ? "not checked" : `${card.qaScore}/100`}
                    </span>
                  </p>
                  <p>
                    {card.attempts} attempt{card.attempts === 1 ? "" : "s"} · $
                    {card.costUsd.toFixed(2)}
                  </p>
                </div>
              </div>

              {card.assetId && urls.get(card.assetId) && (
                <a
                  href={urls.get(card.assetId)}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-block text-xs font-medium text-brand-strong underline"
                >
                  Open the asset
                </a>
              )}

              <div className="mt-3 space-y-2">
                {findingList("Blocking", card.blockers, "text-destructive")}
                {findingList("Worth a look", card.warnings, "text-foreground")}
                {findingList("Noted", card.notes, "text-muted-foreground")}
                {card.reasons.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">Why this idea</p>
                    <ul className="space-y-0.5">
                      {card.reasons.map((why, i) => (
                        <li key={i} className="text-xs text-muted-foreground">
                          {why}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy === card.slotId}
                  onClick={() => void act("approve_slot", card.slotId)}
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Approve and schedule
                </button>
                <button
                  type="button"
                  disabled={busy === card.slotId}
                  onClick={() => {
                    setReason("");
                    setRejecting(card);
                  }}
                  className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-destructive disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {rejected.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">Rejected</h3>
          <p className="text-xs text-muted-foreground">
            Sending one back makes it again from the same idea. It is a separate act from rejecting
            it, so "no, and stop" and "no, try again" stay different decisions.
          </p>
          <ul className="space-y-2">
            {rejected.map((slot) => (
              <li
                key={slot.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
              >
                <div className="space-y-0.5">
                  <p className="text-xs text-muted-foreground">
                    {[slot.platform, slot.format].filter(Boolean).join(" · ")}
                  </p>
                  <p className="text-xs text-foreground">
                    {slot.blocked_reason?.trim() || "No reason recorded."}
                  </p>
                </div>
                {slot.idea_id ? (
                  <button
                    type="button"
                    disabled={busy === slot.id}
                    onClick={() => void act("regenerate_slot", slot.id)}
                    className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Make it again
                  </button>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    No idea on it to write a new brief from.
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <Modal
        open={rejecting !== null}
        onClose={() => setRejecting(null)}
        title={rejecting ? `Reject "${rejecting.assetTitle}"` : "Reject"}
      >
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Say why. The engine writes the next attempt from this, so a rejection with no reason
            leaves it to make the same thing again — and reject_slot refuses one.
          </p>
          <label htmlFor="slot-reject-reason" className="sr-only">
            Why it is rejected
          </label>
          <textarea
            id="slot-reject-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={4}
            className="w-full rounded-md border border-input bg-background p-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setRejecting(null)}
              className="rounded-md px-3.5 py-2 text-sm font-medium text-muted-foreground hover:bg-accent"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!reason.trim()}
              onClick={() => {
                const card = rejecting;
                setRejecting(null);
                if (card) void act("reject_slot", card.slotId, { p_reason: reason.trim() });
                setReason("");
              }}
              className="rounded-md bg-destructive px-3.5 py-2 text-sm font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Reject
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
