import type { FieldDef, FormValues } from "./fields";

const DRAFT_PREFIX = "aa-console:draft:";

// Versioned keys let startup cleanup remove drafts written by the old,
// credential-persisting form without discarding safe drafts on every reload.
export const teamMemberDraftKey = (category: string) => `team-member-v2:${category}`;
export const integrationDraftKey = (clientId: string) => `integration-v2:${clientId}`;

function sensitiveNames(fields: FieldDef[]): Set<string> {
  return new Set(fields.filter((field) => field.kind === "password" || field.sensitive)
    .map((field) => field.name));
}

/**
 * Older versions saved the Team password and Vault credential in drafts.
 * Remove those entire known draft families on the next app load; neither the
 * values nor the old JSON are read, parsed, or logged during this cleanup.
 */
export function purgeLegacySensitiveDrafts() {
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(`${DRAFT_PREFIX}team-member:`)
        || key?.startsWith(`${DRAFT_PREFIX}integration:`)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // Storage may be unavailable in private browsing or during SSR.
  }
}

purgeLegacySensitiveDrafts();

export function clearDraft(key: string | undefined) {
  if (!key) return;
  try {
    localStorage.removeItem(DRAFT_PREFIX + key);
  } catch {
    /* ignore */
  }
}

/** Files and sensitive fields cannot be part of a persisted draft. */
export function readDraft(key: string | undefined, fields: FieldDef[]): FormValues | undefined {
  if (!key) return undefined;
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + key);
    if (!raw) return undefined;
    const stored: unknown = JSON.parse(raw);
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
      clearDraft(key);
      return undefined;
    }
    const sensitive = sensitiveNames(fields);
    const safe = Object.fromEntries(Object.entries(stored).filter(([name]) => !sensitive.has(name)));
    if (Object.keys(safe).length !== Object.keys(stored).length) {
      // Delete the unsafe source first. A failed write (quota, private mode)
      // must not leave the old serialized sensitive value on disk.
      localStorage.removeItem(DRAFT_PREFIX + key);
      if (Object.keys(safe).length) {
        try {
          localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify(safe));
        } catch {
          // The safe draft is optional; the unsafe source has been removed.
        }
      }
    }
    return safe as FormValues;
  } catch {
    return undefined;
  }
}

export function writeDraft(key: string | undefined, values: FormValues, fields: FieldDef[]) {
  if (!key) return;
  try {
    const sensitive = sensitiveNames(fields);
    const persistable = Object.fromEntries(
      Object.entries(values).filter(([name, value]) => !sensitive.has(name) && !(value instanceof File)),
    );
    localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify(persistable));
  } catch {
    /* private mode or quota — drafts are a convenience, never a requirement */
  }
}

/** Clear in-memory sensitive fields as soon as a modal closes. */
export function withoutSensitiveValues(values: FormValues, fields: FieldDef[]): FormValues {
  const sensitive = sensitiveNames(fields);
  return Object.fromEntries(Object.entries(values).map(([name, value]) =>
    [name, sensitive.has(name) ? "" : value])) as FormValues;
}
