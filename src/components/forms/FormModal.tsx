import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Modal } from "../Modal";
import { FieldControl, isVisible, titleFromFile } from "./fields";
import type { FieldDef, FormValues } from "./fields";

const DRAFT_PREFIX = "aa-console:draft:";

/** Files cannot be serialised, so drafts keep everything else. */
function readDraft(key: string | undefined): FormValues | undefined {
  if (!key) return undefined;
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + key);
    return raw ? (JSON.parse(raw) as FormValues) : undefined;
  } catch {
    return undefined;
  }
}

function writeDraft(key: string | undefined, values: FormValues) {
  if (!key) return;
  try {
    const persistable = Object.fromEntries(
      Object.entries(values).filter(([, v]) => !(v instanceof File)),
    );
    localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify(persistable));
  } catch {
    /* private mode or quota — drafts are a convenience, never a requirement */
  }
}

function clearDraft(key: string | undefined) {
  if (!key) return;
  try {
    localStorage.removeItem(DRAFT_PREFIX + key);
  } catch {
    /* ignore */
  }
}

function blankValues(fields: FieldDef[], initial?: FormValues): FormValues {
  const out: FormValues = {};
  for (const f of fields) {
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
  initialValues,
  draftKey,
  onSubmit,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  fields: FieldDef[];
  submitLabel?: string;
  intro?: string;
  /** Seed values for an edit/upsert form. */
  initialValues?: FormValues;
  /**
   * Persists what has been typed under this key so it survives closing the
   * modal and reloading the app. Cleared once the form saves successfully.
   */
  draftKey?: string;
  onSubmit: (values: FormValues) => Promise<void>;
  onSaved?: () => void;
}) {
  const [values, setValues] = useState<FormValues>(() =>
    blankValues(fields, readDraft(draftKey) ?? initialValues),
  );
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset every time the modal opens so a cancelled edit never leaks
  // into the next one.
  useEffect(() => {
    if (open) {
      // A saved draft wins over the stored row, so an unfinished edit is
      // never silently thrown away.
      setValues(blankValues(fields, readDraft(draftKey) ?? initialValues));
      setTouched(readDraft(draftKey) ? Object.fromEntries(fields.map((f) => [f.name, true])) : {});
      setError(null);
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialValues, draftKey]);

  const visible = useMemo(() => fields.filter((f) => isVisible(f, values)), [fields, values]);

  function setValue(field: FieldDef, next: string | boolean | File | null) {
    setValues((prev) => {
      const updated: FormValues = { ...prev, [field.name]: next };
      setTouched((t) => ({ ...t, [field.name]: true }));

      // Recompute anything derived from this field, unless the user has
      // already typed in the derived field themselves.
      for (const candidate of fields) {
        if (candidate.derivedFrom?.field !== field.name) continue;
        if (touched[candidate.name]) continue;
        const source =
          candidate.kind === "text" && next instanceof File
            ? titleFromFile(next)
            : typeof next === "string"
              ? next
              : "";
        updated[candidate.name] = candidate.derivedFrom.transform(source);
      }
      writeDraft(draftKey, updated);
      return updated;
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const missing = visible.filter((f) => {
      if (!f.required) return false;
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
      onClose();
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Could not save.");
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={title}>
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

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
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
