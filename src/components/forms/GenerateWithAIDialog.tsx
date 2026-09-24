import { useState } from "react";
import type { ReactNode } from "react";
import { callRuntime } from "../../lib/callRuntime";

/**
 * Ask for what the records cannot know, and fill the form from the rest.
 *
 * One dialog, because there are now two of these and will be more. They differ
 * only in what they ask for and which endpoint answers, and two copies of a
 * button that spends money on a model call do not stay the same for long.
 *
 * Deliberately one free-text box rather than a field per fact. Nobody knows in
 * advance which details matter, and a form asking for seven specific things
 * collects seven blanks.
 *
 * @param requireNotes Whether the box must be filled. A hiring brief needs it —
 *   the operator knows things about a role that are written down nowhere. A
 *   campaign does not: the business's own strategy is already on file, so a
 *   blank box should still produce a real proposal.
 * @param maxNotesLength Longest the box accepts, or `null` for no limit. A
 *   campaign's steer can be a whole pasted strategy, so it passes `null`; the
 *   endpoints that still cap their notes keep the 4000 default to match.
 */
export function GenerateWithAIDialog<T>({
  open,
  title,
  intro,
  label,
  placeholder,
  endpoint,
  payload,
  requireNotes = true,
  maxNotesLength = 4000,
  footnote,
  extra,
  onClose,
  onGenerated,
}: {
  open: boolean;
  title: string;
  intro: string;
  label: string;
  placeholder: string;
  endpoint: string;
  /** Sent alongside `notes` — the client, the role, whatever identifies the subject. */
  payload: Record<string, unknown>;
  requireNotes?: boolean;
  maxNotesLength?: number | null;
  footnote?: string;
  /** Rendered above the notes box — a choice the generator needs first. */
  extra?: ReactNode;
  onClose: () => void;
  onGenerated: (draft: T, sources?: string, dropped?: { field: string; reason: string }[]) => void;
}) {
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (!open) return null;

  const generate = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await callRuntime<{
        draft: T;
        sources?: string;
        dropped?: { field: string; reason: string }[];
      }>(endpoint, { ...payload, notes: notes.trim() });
      onGenerated(result.draft, result.sources, result.dropped);
      setNotes("");
      onClose();
    } catch (error) {
      // The runtime's own sentence — "the ask names a budget", "the primary
      // text is too thin to be an ad" — written to be read by whoever pressed
      // the button, so it is shown rather than replaced with something generic.
      setProblem(error instanceof Error ? error.message : "That did not work.");
    }
    setBusy(false);
  };

  const blocked = busy || (requireNotes && notes.trim().length === 0);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-foreground/40"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="generate-with-ai-title"
        className="relative w-full max-w-lg rounded-lg border border-border bg-card p-5 shadow-lg"
      >
        <h2 id="generate-with-ai-title" className="text-base font-semibold text-card-foreground">
          {title}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{intro}</p>

        {extra && <div className="mt-4">{extra}</div>}

        <label htmlFor="generate-with-ai-notes" className="mt-4 block text-sm font-medium text-card-foreground">
          {label}
        </label>
        <textarea
          id="generate-with-ai-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={6}
          maxLength={maxNotesLength ?? undefined}
          disabled={busy}
          placeholder={placeholder}
          className="mt-2 w-full rounded-md border border-input bg-background p-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        />

        {footnote && <p className="mt-2 text-xs text-muted-foreground">{footnote}</p>}

        {problem && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {problem}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={blocked}
            onClick={() => void generate()}
            className="rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {busy ? "Writing…" : "Generate"}
          </button>
        </div>
      </div>
    </div>
  );
}
