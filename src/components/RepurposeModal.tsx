import { useState } from "react";
import { Repeat } from "lucide-react";
import { supabase } from "../lib/supabase";
import { cn } from "../lib/cn";

/**
 * Turn one finished asset into briefs for the other formats it should exist in.
 *
 * Deliberately not a "Generate Reel" button. AA cannot cut video, so what this
 * produces is a brief per format, which then goes through Approve & Build or a
 * dispatch like any other. The wording says so, because a control implying a
 * finished reel is coming would be lying about what happens next.
 */
const FORMATS: Array<{ key: string; label: string; note: string; makes: string }> = [
  { key: "reel", label: "Reel", note: "20–45s vertical, one sharpest beat", makes: "video brief" },
  { key: "short", label: "Short", note: "Under 30s, claim in the first three seconds", makes: "video brief" },
  { key: "story_clips", label: "Story clips", note: "3–5 frames, readable on mute", makes: "video brief" },
  { key: "carousel", label: "Carousel", note: "6–8 frames, frame one earns the swipe", makes: "image brief" },
  { key: "quote_graphic", label: "Quote graphic", note: "One line a reader would repeat", makes: "image brief" },
  { key: "ad_variation", label: "Ad variation", note: "Same offer, different entry point", makes: "image brief" },
  { key: "text_post", label: "Text post", note: "Works with no image", makes: "text brief" },
  { key: "email", label: "Email", note: "Subject, preview and body", makes: "text brief" },
];

const MAX = 6;

export function RepurposeModal({
  assetId,
  assetTitle,
  open,
  onClose,
  onQueued,
}: {
  assetId: string;
  assetTitle: string;
  open: boolean;
  onClose: () => void;
  onQueued?: () => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const toggle = (key: string) =>
    setPicked((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : prev.length >= MAX ? prev : [...prev, key],
    );

  const submit = async () => {
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("repurpose_asset", {
      p_asset_id: assetId,
      p_formats: picked,
    });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    onQueued?.();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-foreground/50"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lg"
      >
        <header className="shrink-0 border-b border-border px-5 py-4">
          <h2 className="flex items-center gap-2 text-base font-semibold text-card-foreground">
            <Repeat className="h-4 w-4" aria-hidden="true" /> Repurpose
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            From <span className="text-foreground">{assetTitle}</span>. Each format becomes a
            production brief, not a finished file — the brief then goes through Approve &amp; Build
            or out to an editor like any other.
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <ul className="space-y-1.5">
            {FORMATS.map((f) => {
              const on = picked.includes(f.key);
              const full = !on && picked.length >= MAX;
              return (
                <li key={f.key}>
                  <label
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-md border p-3",
                      on ? "border-primary bg-primary/5" : "border-border hover:border-primary/50",
                      full && "cursor-not-allowed opacity-50",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={full}
                      onChange={() => toggle(f.key)}
                      className="mt-0.5 h-4 w-4 rounded border-input"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-2">
                        <span className="text-sm font-medium text-card-foreground">{f.label}</span>
                        <span className="text-xs text-muted-foreground">{f.makes}</span>
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{f.note}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>

          {error && (
            <p role="alert" className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-5 py-3">
          <span className="text-xs text-muted-foreground">
            {picked.length === 0
              ? `Pick up to ${MAX}. Each one is a model call.`
              : `${picked.length} of ${MAX} · roughly $${(picked.length * 0.2).toFixed(2)}`}
          </span>
          <span className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={picked.length === 0 || busy}
              onClick={() => void submit()}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {busy ? "Queuing…" : `Write ${picked.length || ""} brief${picked.length === 1 ? "" : "s"}`}
            </button>
          </span>
        </footer>
      </div>
    </div>
  );
}
