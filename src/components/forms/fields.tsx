import type { ChangeEvent } from "react";

export type Option = { value: string; label: string };

export type FieldDef = {
  name: string;
  label: string;
  kind: "text" | "textarea" | "number" | "date" | "select" | "toggle" | "file" | "password";
  required?: boolean;
  placeholder?: string;
  hint?: string;
  rows?: number;
  accept?: string;
  options?: Option[];
  /** Render only when another field currently holds one of these values. */
  showIf?: { field: string; equals: string[] };
  /** Recomputed from another field until the user edits this one directly. */
  derivedFrom?: { field: string; transform: (value: string) => string };
};

export type FormValues = Record<string, string | boolean | File | null>;

const inputClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function isVisible(field: FieldDef, values: FormValues): boolean {
  if (!field.showIf) return true;
  const current = values[field.showIf.field];
  return typeof current === "string" && field.showIf.equals.includes(current);
}

export function FieldControl({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: string | boolean | File | null;
  onChange: (next: string | boolean | File | null) => void;
}) {
  const id = `field-${field.name}`;
  const text = typeof value === "string" ? value : "";

  function handle(e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
    onChange(e.target.value);
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="flex items-baseline gap-2 text-sm font-medium text-foreground">
        {field.label}
        {field.required && (
          <span className="text-xs font-normal text-destructive" aria-hidden="true">
            required
          </span>
        )}
      </label>

      {field.kind === "textarea" ? (
        <textarea
          id={id}
          rows={field.rows ?? 3}
          value={text}
          onChange={handle}
          placeholder={field.placeholder}
          className={inputClass}
        />
      ) : field.kind === "select" ? (
        <select id={id} value={text} onChange={handle} className={inputClass}>
          <option value="">Select…</option>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : field.kind === "toggle" ? (
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            className="h-4 w-4 rounded border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {field.placeholder ?? "Yes"}
        </label>
      ) : field.kind === "file" ? (
        <input
          id={id}
          type="file"
          accept={field.accept}
          onChange={(e) => onChange(e.target.files?.[0] ?? null)}
          className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground file:mr-3 file:rounded file:border-0 file:bg-secondary file:px-2.5 file:py-1 file:text-xs file:text-secondary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      ) : (
        <input
          id={id}
          type={
            field.kind === "number"
              ? "number"
              : field.kind === "date"
                ? "date"
                : field.kind === "password"
                  ? "password"
                  : "text"
          }
          value={text}
          onChange={handle}
          placeholder={field.placeholder}
          autoComplete={field.kind === "password" ? "new-password" : "off"}
          className={inputClass}
        />
      )}

      {field.hint && <p className="text-xs text-muted-foreground">{field.hint}</p>}
    </div>
  );
}

/** Initials from a name: "Attract Acquisition" -> "AA". */
export function initialsFrom(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

/** Slug from a name: "Brand Strategist" -> "brand_strategist". */
export function slugFrom(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/** Filename without its extension, for auto-titling uploads. */
export function titleFromFile(file: File | null): string {
  if (!file) return "";
  return file.name.replace(/\.[^.]+$/, "");
}
