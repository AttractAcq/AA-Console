import { useState } from "react";
import { callRuntime } from "../../lib/callRuntime";

export type GeneratedBrief = {
  title: string;
  hook: string;
  script: string;
  call_to_action: string;
  visual_direction: string;
  premise: string;
};

/**
 * Ask for what is specific about this opening, and write the brief from it.
 *
 * The form it fills used to open pre-filled with one of three canned briefs.
 * The operator's real knowledge of the role — must cut vertical, Durban hours,
 * starts January — had nowhere to go except over the top of a stub. This is
 * where it goes instead, and it is the only input the generator cannot get
 * from AA's own records.
 *
 * Deliberately one free-text box rather than a field per fact. Nobody knows in
 * advance which details matter for a particular hire, and a form that asks for
 * seven specific things collects seven blanks.
 */
export function GenerateBriefDialog({
  open,
  role,
  roleLabel,
  onClose,
  onGenerated,
}: {
  open: boolean;
  role: string;
  roleLabel: string;
  onClose: () => void;
  onGenerated: (draft: GeneratedBrief) => void;
}) {
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (!open) return null;

  const generate = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await callRuntime<{ draft: GeneratedBrief }>("/admin/recruitment/draft", {
        role,
        notes: notes.trim(),
      });
      onGenerated(result.draft);
      setNotes("");
      onClose();
    } catch (error) {
      // The runtime's own sentence: "the primary text is too thin to be an ad",
      // "the copy contains a link". Written to be read by whoever pressed it.
      setProblem(error instanceof Error ? error.message : "That did not work.");
    }
    setBusy(false);
  };

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
        aria-labelledby="generate-brief-title"
        className="relative w-full max-w-lg rounded-lg border border-border bg-card p-5 shadow-lg"
      >
        <h2 id="generate-brief-title" className="text-base font-semibold text-card-foreground">
          Write the {roleLabel} ad
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Say what is specific about this opening. Everything else — what AA does, how it sounds,
          what it can prove — is already on file and will be read for you.
        </p>

        <label htmlFor="generate-brief-notes" className="mt-4 block text-sm font-medium text-card-foreground">
          About this role
        </label>
        <textarea
          id="generate-brief-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={6}
          maxLength={4000}
          disabled={busy}
          placeholder="What the person will actually do, the hours, where they work, what you will not compromise on, anything that would put the wrong applicant off."
          className="mt-2 w-full rounded-md border border-input bg-background p-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        />

        <p className="mt-2 text-xs text-muted-foreground">
          The rate and the apply link are never written for you — you fill those in yourself.
        </p>

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
            disabled={busy || notes.trim().length === 0}
            onClick={() => void generate()}
            className="rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {busy ? "Writing…" : "Generate"}
          </button>
        </div>
      </div>
    </div>
  );
}
