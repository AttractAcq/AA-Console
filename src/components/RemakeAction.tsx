import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { supabase } from "../lib/supabase";
import { Modal } from "./Modal";

/**
 * Build a rejected asset again, with the rejection reason carried into it.
 *
 * Rejection used to end here. The reason was recorded and nothing consumed
 * it — one rejection existed in production, fourteen days old, and nothing
 * was ever remade from it.
 *
 * The reason is shown before the remake is confirmed, because it is what the
 * next attempt will be written against. Somebody about to spend a model call
 * should see what the build is being told.
 */
export function RemakeAction({
  assetId,
  hasBrief,
  onDone,
  onError,
  onNotice,
}: {
  assetId: string;
  hasBrief: boolean;
  onDone: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from("client_asset_reviews")
        .select("reason")
        .eq("asset_id", assetId)
        .eq("decision", "rejected")
        .order("created_at", { ascending: false })
        .limit(1);
      if (!cancelled) setReason(data?.[0]?.reason ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, assetId]);

  async function remake() {
    setBusy(true);
    const { error } = await supabase.rpc("remake_rejected_asset", { p_asset_id: assetId });
    setBusy(false);
    if (error) {
      onError(error.message);
      return;
    }
    setOpen(false);
    onNotice("Queued a remake. The build is running now, working against that feedback.");
    onDone();
  }

  // An asset with no brief cannot be rebuilt from anything — the RPC refuses
  // it, and offering the button would be offering a guaranteed failure.
  if (!hasBrief) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-card-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
        Remake
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title="Build this again">
        <div className="space-y-3">
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              What the build will be told went wrong
            </p>
            <p className="mt-1 whitespace-pre-wrap rounded-md border border-border bg-cool-surface p-3 text-sm text-foreground">
              {reason ?? "No reason was recorded on this rejection."}
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            The brief has not changed. The concept is written again against that feedback, and it
            costs a model call.
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
              disabled={busy || !reason?.trim()}
              onClick={() => void remake()}
              className="rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {busy ? "Queueing…" : "Remake"}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
