import { useState } from "react";
import { ShieldCheck, ShieldAlert, ShieldX } from "lucide-react";
import { supabase } from "../../lib/supabase";
import type { ProofAsset } from "../../lib/media";
import { cn } from "../../lib/cn";

/**
 * One proof record, structured so the rest of the system can use it.
 *
 * The point of the structure is a single question — "the strongest usable
 * proof for this buyer and this claim" — which a title and a paragraph cannot
 * answer. So the fields that make it answerable (claim, who it lands with,
 * strength) lead, and usage rights are the gate: nothing reaches advertising
 * until a person says it may.
 */
export const PROOF_TYPES = [
  "customer_result", "testimonial", "review", "case_study", "before_after",
  "stat", "credential", "award", "press", "process", "team_expertise", "customer_story",
] as const;

const RIGHTS: Array<{ id: string; label: string; note: string; icon: typeof ShieldCheck; tone: string }> = [
  { id: "approved", label: "Cleared", note: "May be used in advertising", icon: ShieldCheck, tone: "text-brand-strong" },
  { id: "restricted", label: "Restricted", note: "Internal or conditional use only", icon: ShieldAlert, tone: "text-muted-foreground" },
  { id: "not_cleared", label: "Not cleared", note: "No permission on record", icon: ShieldX, tone: "text-destructive" },
];

const label = (s: string) => s.replace(/_/g, " ");

export function ProofDetailModal({
  proof,
  open,
  onClose,
  onSaved,
}: {
  proof: ProofAsset | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  if (!open || !proof) return null;

  // Reset when a different record opens, without an effect that would fight
  // the user's typing on every parent render.
  if (loadedFor !== proof.id) {
    setLoadedFor(proof.id);
    setForm({
      proof_type: proof.proof_type ?? "",
      claim: proof.claim ?? "",
      evidence: proof.evidence ?? "",
      avatar_relevance: proof.avatar_relevance ?? "",
      services: proof.services ?? "",
      strength: proof.strength ?? "medium",
      usage_rights: proof.usage_rights ?? "not_cleared",
      captured_on: proof.captured_on ?? "",
      expires_on: proof.expires_on ?? "",
    });
    setError(null);
  }

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from("client_proof_assets")
      .update({
        proof_type: form.proof_type || null,
        claim: form.claim?.trim() || null,
        evidence: form.evidence?.trim() || null,
        avatar_relevance: form.avatar_relevance?.trim() || null,
        services: form.services?.trim() || null,
        strength: form.strength || "medium",
        usage_rights: form.usage_rights || "not_cleared",
        captured_on: form.captured_on || null,
        expires_on: form.expires_on || null,
      })
      .eq("id", proof.id);
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    onSaved();
    onClose();
  };

  const field = (name: string, text: string, hint?: string, rows?: number) => (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {text}
      </span>
      {rows ? (
        <textarea
          aria-label={text}
          rows={rows}
          value={form[name] ?? ""}
          onChange={(e) => set(name, e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      ) : (
        <input
          aria-label={text}
          value={form[name] ?? ""}
          onChange={(e) => set(name, e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      )}
      {hint && <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-foreground/50" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className="relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lg"
      >
        <header className="shrink-0 border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold text-card-foreground">
            {proof.title ?? "Untitled proof"}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {proof.ref_number ? `${proof.ref_number} · ` : ""}
            {proof.media_type}
            {proof.source ? ` · ${proof.source}` : ""}
          </p>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {/* Rights first: it decides whether anything below can be used at
              all, so burying it under the descriptive fields would be wrong. */}
          <div>
            <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Usage rights
            </span>
            <div className="grid gap-2 sm:grid-cols-3">
              {RIGHTS.map((r) => {
                const Icon = r.icon;
                const on = form.usage_rights === r.id;
                return (
                  <button
                    key={r.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => set("usage_rights", r.id)}
                    className={cn(
                      "rounded-md border p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      on ? "border-primary bg-primary/5" : "border-border hover:border-primary/50",
                    )}
                  >
                    <span className={cn("flex items-center gap-1.5 text-sm font-medium", r.tone)}>
                      <Icon className="h-4 w-4" aria-hidden="true" /> {r.label}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{r.note}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {field("claim", "Claim", "The one specific thing this proves. Not \"we do good work\".", 2)}
          {field("evidence", "Evidence", "What backs it, so a sceptic can judge it.", 2)}
          {field("avatar_relevance", "Lands with", "Which buyer. This is what makes it findable for a brief.")}
          {field("services", "Service")}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Type
              </span>
              <select
                aria-label="Type"
                value={form.proof_type ?? ""}
                onChange={(e) => set("proof_type", e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">Not set</option>
                {PROOF_TYPES.map((t) => (
                  <option key={t} value={t}>{label(t)}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Strength
              </span>
              <select
                aria-label="Strength"
                value={form.strength ?? "medium"}
                onChange={(e) => set("strength", e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Captured on
              </span>
              <input
                type="date"
                aria-label="Captured on"
                value={form.captured_on ?? ""}
                onChange={(e) => set("captured_on", e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Expires
              </span>
              <input
                type="date"
                aria-label="Expires"
                value={form.expires_on ?? ""}
                onChange={(e) => set("expires_on", e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                After this date it stops being offered to agents.
              </span>
            </label>
          </div>

          {proof.body && (
            <div>
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                As filed
              </span>
              <p className="whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
                {proof.body}
              </p>
            </div>
          )}

          {error && (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
        </div>

        <footer className="flex shrink-0 justify-end gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}
