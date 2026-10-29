import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Modal } from "../Modal";
import { FieldControl, isVisible, titleFromFile } from "./fields";
import type { FieldDef, FormValues } from "./fields";
import { clearDraft, readDraft, writeDraft } from "./draftStorage";

export { clearDraft } from "./draftStorage";

function blankValues(fields: FieldDef[], initial?: FormValues): FormValues {
  const out: FormValues = {};
  for (const f of fields) {
    if (f.kind === "heading") continue;
    const seed = initial?.[f.name];
    if (seed !== undefined && seed !== null) out[f.name] = seed;
    else out[f.name] = f.kind === "toggle" ? false : f.kind === "file" ? null : "";
  }
  return out;
}

/**
 * The one form component behind every input button in the app. Give it a
 * field list and a submit handler; it owns state, derived fields,
 * required-field validation, the busy state and error reporting.
 */
export function FormModal({
  open,
  onClose,
  title,
  fields,
  submitLabel = "Save",
  intro,
  extra,
  actions,
  initialValues,
  draftKey,
  resetKey,
  onSubmit,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  fields: FieldDef[];
  submitLabel?: string;
  intro?: string;
  /** Rendered under the fields — a choice the form needs that is not a field. */
  extra?: ReactNode;
  /** Extra controls in the footer, beside Cancel — e.g. "Generate with AI". */
  actions?: ReactNode;
  /** Seed values for an edit/upsert form. */
  initialValues?: FormValues;
  /**
   * Persists only fields allowed by draftStorage's explicit policy for this
   * key, in this browser tab. Cleared once the form saves successfully.
   */
  draftKey?: string;
  /** A changed value deliberately replaces in-progress edits, such as an AI-generated draft. */
  resetKey?: unknown;
  onSubmit: (values: FormValues) => Promise<void>;
  onSaved?: () => void;
}) {
  const [values, setValues] = useState<FormValues>(() =>
    open ? blankValues(fields, { ...initialValues, ...readDraft(draftKey, fields) }) : blankValues(fields),
  );
  const touched = useRef<Record<string, boolean>>({});
  const previousInputs = useRef({ open: false, draftKey, resetKey });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Preserve edits through live parent refreshes. A new opening, form identity
  // or explicit reset replaces them with current server values plus safe draft.
  useEffect(() => {
    const prior = previousInputs.current;
    const reset = !prior.open || prior.draftKey !== draftKey || prior.resetKey !== resetKey;
    previousInputs.current = { open, draftKey, resetKey };
    if (open) {
      const draft = readDraft(draftKey, fields);
      const seeded = blankValues(fields, { ...initialValues, ...draft });
      if (reset) {
        setValues(seeded);
        touched.current = draft ? Object.fromEntries(Object.keys(draft).map((name) => [name, true])) : {};
        setError(null);
        setBusy(false);
      } else {
        setValues((previous) => {
          const updated = { ...previous };
          let changed = false;
          for (const field of fields) {
            if (field.kind === "heading" || touched.current[field.name]
              || (field.derivedFrom && touched.current[field.derivedFrom.field])) continue;
            if (updated[field.name] !== seeded[field.name]) {
              updated[field.name] = seeded[field.name];
              changed = true;
            }
          }
          return changed ? updated : previous;
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialValues, draftKey, resetKey]);

  const visible = useMemo(() => fields.filter((f) => isVisible(f, values)), [fields, values]);

  function setValue(field: FieldDef, next: string | boolean | File | null) {
    touched.current[field.name] = true;
    setValues((prev) => {
      const updated: FormValues = { ...prev, [field.name]: next };

      // Recompute anything derived from this field, unless the user has
      // already typed in the derived field themselves.
      for (const candidate of fields) {
        if (candidate.derivedFrom?.field !== field.name) continue;
        if (touched.current[candidate.name]) continue;
        const source =
          candidate.kind === "text" && next instanceof File
            ? titleFromFile(next)
            : typeof next === "string"
              ? next
              : "";
        updated[candidate.name] = candidate.derivedFrom.transform(source);
      }
      writeDraft(draftKey, updated, fields);
      return updated;
    });
  }

  function close() {
    setValues(blankValues(fields));
    touched.current = {};
    onClose();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const missing = visible.filter((f) => {
      if (!f.required || f.kind === "heading") return false;
      const v = values[f.name];
      if (f.kind === "file") return !(v instanceof File);
      if (f.kind === "toggle") return false;
      return typeof v !== "string" || v.trim() === "";
    });
    if (missing.length > 0) {
      setError(`${missing.map((f) => f.label).join(", ")} ${missing.length > 1 ? "are" : "is"} required.`);
      return;
    }

    setError(null);
    setBusy(true);
    try {
      await onSubmit(values);
      clearDraft(draftKey);
      setBusy(false);
      onSaved?.();
      close();
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Could not save.");
    }
  }

  return (
    <Modal open={open} onClose={close} title={title}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {intro && <p className="text-sm text-muted-foreground">{intro}</p>}

        {visible.map((field) => (
          <FieldControl
            key={field.name}
            field={field}
            value={values[field.name]}
            onChange={(next) => setValue(field, next)}
          />
        ))}

        {extra}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          {/* Left of Cancel, because it acts on the form rather than closing it. */}
          {actions && <div className="mr-auto">{actions}</div>}
          <button
            type="button"
            onClick={close}
            className="rounded-md px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {busy ? "Saving…" : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** A confirm-only action: no fields, one call. */
export function ConfirmModal({
  open,
  onClose,
  title,
  body,
  confirmLabel = "Confirm",
  onConfirm,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  body: string;
  confirmLabel?: string;
  onConfirm: () => Promise<void>;
  onDone?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setBusy(false);
      setError(null);
    }
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{body}</p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                setBusy(false);
                onDone?.();
                onClose();
              } catch (err) {
                setBusy(false);
                setError(err instanceof Error ? err.message : "Could not complete.");
              }
            }}
            className="rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
