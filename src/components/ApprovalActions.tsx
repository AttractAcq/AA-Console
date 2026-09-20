import { useState } from "react";
import { supabase } from "../lib/supabase";
import { Modal } from "./Modal";

/**
 * Approve or reject one asset.
 *
 * review_media_asset() is called from five screens, and before this each one
 * carried its own copy of the pair. That is how "approve" came to mean
 * slightly different things in different places — one asked for a rejection
 * reason, another did not.
 *
 * Rejecting always asks why. A rejection with no reason sends the maker back
 * with nothing to act on, and the reason is the only part of the decision
 * anything downstream could use.
 */
export function ApprovalActions({
  assetId,
  title,
  onDone,
  onError,
}: {
  assetId: string;
  title: string;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  async function review(decision: "approved" | "rejected", why?: string) {
    setBusy(true);
    const { error } = await supabase.rpc("review_media_asset", {
      p_asset_id: assetId,
      p_decision: decision,
      p_reason: why?.trim() || undefined,
    });
    setBusy(false);
    if (error) {
      onError(error.message);
      return;
    }
    onDone();
  }

  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={() => void review("approved")}
        className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Approve
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => setRejecting(true)}
        className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Reject
      </button>

      <Modal open={rejecting} onClose={() => setRejecting(false)} title={`Reject "${title}"`}>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Say what is wrong with it. This goes back to whoever made it, and it is the only part of
            the decision they can act on.
          </p>
          <label htmlFor={`reject-reason-${assetId}`} className="sr-only">
            Why it is rejected
          </label>
          <textarea
            id={`reject-reason-${assetId}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={4}
            className="w-full rounded-md border border-input bg-background p-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setRejecting(false)}
              className="rounded-md px-3.5 py-2 text-sm font-medium text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!reason.trim() || busy}
              onClick={() => {
                setRejecting(false);
                void review("rejected", reason);
                setReason("");
              }}
              className="rounded-md bg-destructive px-3.5 py-2 text-sm font-medium text-destructive-foreground transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Reject
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
