import { useCallback, useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { fetchFrames } from "../lib/frames";
import type { Frame } from "../lib/frames";
import { signPaths } from "../lib/media";
import { supabase } from "../lib/supabase";
import { Modal } from "./Modal";
import { cn } from "../lib/cn";

/**
 * The frames of a carousel or story, in the order they run.
 *
 * Nothing showed these before: the library showed a count and the detail
 * modal showed the cover, so a five-frame set was judged on frame one. You
 * cannot say frame three is wrong if you have never seen frame three, which
 * is also why per-frame regeneration had nowhere to live.
 *
 * WHY REBUILDING ONE FRAME MAKES A WHOLE NEW ASSET
 *
 * The same reason Regenerate does. An approved set may already be scheduled;
 * changing a frame underneath it alters what goes out with nothing approved.
 * So the rebuild produces a new asset that carries the other frames across
 * unchanged — one image call, and a fresh decision on the set as a whole,
 * which is what a person actually approves.
 */
export function FrameStrip({
  assetId,
  onQueued,
  onError,
}: {
  assetId: string;
  onQueued: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [remaking, setRemaking] = useState<Frame | null>(null);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await fetchFrames(assetId);
      setFrames(rows);
      setUrls(await signPaths("client-media", rows.map((f) => f.storage_path)));
    } catch {
      // A strip that cannot load is decoration failing, not the asset being
      // broken — the same rule countFrames follows. The modal around it must
      // still render.
      setFrames([]);
    }
    setLoading(false);
  }, [assetId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remake() {
    if (!remaking) return;
    setBusy(true);
    const { error } = await supabase.rpc("regenerate_frame", {
      p_asset_id: assetId,
      p_position: remaking.position,
      p_feedback: feedback.trim(),
    });
    setBusy(false);
    if (error) {
      onError(error.message);
      return;
    }
    onQueued(
      `Rebuilding frame ${remaking.position}. The other frames carry over unchanged, and the result arrives as a new set awaiting approval.`,
    );
    setRemaking(null);
    setFeedback("");
  }

  if (loading) return <p className="px-5 py-4 text-sm text-muted-foreground">Loading frames…</p>;
  if (frames.length === 0) return null;

  return (
    <div className="border-t border-border px-5 py-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {frames.length} frames, in order
      </h3>
      <ul className="flex gap-3 overflow-x-auto pb-1">
        {frames.map((frame) => (
          <li key={frame.id} className="w-32 shrink-0">
            <div className="relative overflow-hidden rounded-md border border-border bg-muted">
              {urls.get(frame.storage_path) ? (
                <img
                  src={urls.get(frame.storage_path)}
                  alt={frame.caption ?? `Frame ${frame.position}`}
                  className="aspect-[2/3] w-full object-cover"
                />
              ) : (
                <div className="aspect-[2/3] w-full" />
              )}
              <span className="absolute left-1 top-1 rounded bg-foreground/70 px-1.5 py-0.5 text-xs font-medium text-background">
                {frame.position}
              </span>
            </div>
            {frame.caption && (
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{frame.caption}</p>
            )}
            {/* Ungated here, like Regenerate beside it: regenerate_frame is
                admin-only and refuses anyone else by name. */}
            <button
              type="button"
              onClick={() => {
                setRemaking(frame);
                setFeedback("");
              }}
              className={cn(
                "mt-1 inline-flex items-center gap-1 rounded text-xs text-brand-strong hover:underline",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              Rebuild
            </button>
          </li>
        ))}
      </ul>

      <Modal
        open={remaking !== null}
        onClose={() => setRemaking(null)}
        title={`Rebuild frame ${remaking?.position ?? ""}`}
      >
        <p className="text-sm text-muted-foreground">
          Only this frame is built again. The other {frames.length - 1} carry over exactly as they
          are, so this costs one image rather than {frames.length}. The result is filed as a new set
          awaiting approval — this one is left alone.
        </p>
        <label htmlFor="frame-remake-feedback" className="mt-4 block text-sm font-medium text-foreground">
          What is wrong with this frame, and what needs to change?
        </label>
        <textarea
          id="frame-remake-feedback"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          rows={4}
          maxLength={2000}
          disabled={busy}
          placeholder="The photo is too dark and the headline repeats frame 2."
          className="mt-2 w-full rounded-md border border-input bg-background p-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setRemaking(null)}
            className="rounded-md px-3.5 py-2 text-sm text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cancel
          </button>
          <button
            type="button"
            // Required, for the reason the RPC also requires it: the same
            // brief with nothing changed produces the same frame and charges
            // for it.
            disabled={busy || feedback.trim().length === 0}
            onClick={() => void remake()}
            className="rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {busy ? "Queueing…" : "Rebuild this frame"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
