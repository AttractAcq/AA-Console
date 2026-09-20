import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { supabase } from "../lib/supabase";
import { Modal } from "./Modal";

/**
 * Build an asset again, with an account of what was wrong.
 *
 * Offered on anything with a brief, not only on rejections. Most of the time
 * you are looking at a finished image that is nearly right and want it built
 * again with one thing changed — no rejection involved.
 *
 * The feedback is required, and the box starts empty. A rejected asset is the
 * one exception: its recorded reason is loaded in, because it is already the
 * answer to this question and asking twice is asking twice.
 */
export function RegenerateAction({
  assetId,
  hasBrief,
  isRejected,
  onDone,
  onError,
  onNotice,
}: {
  assetId: string;
  hasBrief: boolean;
  isRejected: boolean;
  onDone: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !isRejected) return;
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from("client_asset_reviews")
        .select("reason")
        .eq("asset_id", assetId)
        .eq("decision", "rejected")
        .order("created_at", { ascending: false })
        .limit(1);
      const reason = data?.[0]?.reason ?? "";
      // Only prefills an empty box, so reopening never discards typing.
      if (!cancelled && reason) setFeedback((current) => current || reason);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, isRejected, assetId]);

  async function regenerate() {
    setBusy(true);
    const { error } = await supabase.rpc("regenerate_asset", {
      p_asset_id: assetId,
      p_feedback: feedback.trim(),
    });
    setBusy(false);
    if (error) {
      onError(error.message);
      return;
    }
    setOpen(false);
    setFeedback("");
    onNotice("Queued a rebuild. It is running now, working against that feedback.");
    onDone();
  }

  // The RPC refuses an asset with no brief, so the button would be a
  // guaranteed failure.
  if (!hasBrief) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-card-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
        Regenerate
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title="Build this again">
        <div className="space-y-3">
          <label htmlFor={`regen-${assetId}`} className="block text-sm font-medium text-card-foreground">
            What is wrong, and what needs to change?
          </label>
          <textarea
            id={`regen-${assetId}`}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={5}
            disabled={busy}
            placeholder="The headline is unreadable at thumbnail size. Lose the stock handshake. The logo is competing with the product."
            className="w-full rounded-md border border-input bg-background p-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          />
          <p className="text-xs text-muted-foreground">
            The brief has not changed, so this is the only thing that will make the next one
            different. It costs a model call, and the current asset is left exactly as it is.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md px-3.5 py-2 text-sm font-medium text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !feedback.trim()}
              onClick={() => void regenerate()}
              className="rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {busy ? "Queueing…" : "Regenerate"}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
