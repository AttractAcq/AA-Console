import type { FieldDef, FormValues } from "./fields";

const LEGACY_PREFIX = "aa-console:draft:";
const SAFE_PREFIX = `${LEGACY_PREFIX}v3:`;
const IDENTITY_KEY = `${LEGACY_PREFIX}session-user`;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// The form key is logical identity only. Safe drafts live in tab-scoped storage,
// expire after a week, and are cleared when the signed-in user changes.
export const teamMemberDraftKey = (category: string) => `team-member-v2:${category}`;
export const integrationDraftKey = (clientId: string) => `integration-v2:${clientId}`;

type SafeRule = { allowed: readonly string[] } | "toggle" | "hex";
type DraftPolicy = { key: RegExp; fields: Record<string, SafeRule> };
const select = (...allowed: string[]): SafeRule => ({ allowed });

const colours: Record<string, SafeRule> = {
  colour_primary: "hex",
  colour_secondary: "hex",
  colour_accent: "hex",
  colour_background: "hex",
  colour_text: "hex",
};
const ideaShape: Record<string, SafeRule> = {
  target_platform: select("instagram", "facebook", "tiktok", "linkedin", "youtube"),
  media_type: select("image", "text", "video"),
  content_format: select("single", "carousel", "story", "reel"),
};

/**
 * Inventory of every production FormModal draftKey. An empty policy is an
 * explicit decision to keep that form in memory only. Unknown future keys
 * also deny every field. Only fixed selections, booleans and complete hex
 * colours may be persisted; free text and identifiers are deliberately absent.
 * Select values have a fixed second allowlist, so adding a dynamic option to
 * a form cannot accidentally make account IDs or credentials persistent.
 */
const POLICIES: readonly DraftPolicy[] = [
  { key: /^add-client$/, fields: { is_internal: "toggle" } },
  { key: /^lead:[^:]+$/, fields: {} },
  { key: /^business-context:[^:]+$/, fields: {} },
  { key: /^onboarding:contact:[^:]+$/, fields: {} },
  { key: /^onboarding:business:[^:]+$/, fields: {} },
  { key: /^onboarding:brand:[^:]+$/, fields: colours },
  { key: /^onboarding:credentials:[^:]+$/, fields: {} },
  { key: /^onboarding:call:[^:]+$/, fields: {} },
  { key: /^brand:[^:]+$/, fields: colours },
  { key: /^contact:[^:]+$/, fields: {} },
  { key: /^billing:[^:]+$/, fields: {} },
  { key: /^contract:[^:]+$/, fields: {} },
  { key: /^audit:[^:]+$/, fields: {} },
  { key: /^integration-v2:[^:]+$/, fields: {
    provider: select("meta", "instagram", "facebook", "resend", "google", "google_business", "other"),
  } },
  { key: /^site-repo:[^:]+$/, fields: {} },
  { key: /^finance-period$/, fields: {} },
  { key: /^finance-entry$/, fields: {} },
  { key: /^spend:[^:]+$/, fields: {} },
  { key: /^add-payment:[^:]+$/, fields: {} },
  { key: /^member-contract-profile:[^:]+$/, fields: {} },
  { key: /^assign-client:[^:]+$/, fields: {} },
  { key: /^assign-job:[^:]+$/, fields: {} },
  { key: /^team-member-v2:[^:]+$/, fields: {} },
  { key: /^recruitment-brief:[^:]+$/, fields: {} },
  { key: /^add-event$/, fields: {} },
  { key: /^add-agent$/, fields: {} },
  { key: /^add-sop$/, fields: {} },
  { key: /^add-channel$/, fields: {} },
  { key: /^proof:[^:]+$/, fields: {
    media_type: select("image", "text", "video"),
    source_format: select("single", "carousel", "story", "reel"),
    capture_method: select("automated_requests", "field_capture", "guided_interview", "integration",
      "manual_import", "outcome_followup"),
    source_category: select("customers", "business_operations", "independent_sources"),
  } },
  { key: /^idea-manual:[^:]+$/, fields: ideaShape },
  { key: /^idea-pillar:[^:]+$/, fields: ideaShape },
  { key: /^idea-proof:[^:]+$/, fields: ideaShape },
  { key: /^ad-copy:[^:]+$/, fields: { ad_cta: select("APPLY_NOW", "BOOK_NOW", "CONTACT_US", "DOWNLOAD",
    "GET_OFFER", "GET_QUOTE", "LEARN_MORE", "SEND_MESSAGE", "SHOP_NOW", "SIGN_UP", "SUBSCRIBE") } },
  { key: /^schedule:[^:]+:[^:]+$/, fields: {} },
  { key: /^page:[^:]+:[^:]+$/, fields: {} },
  { key: /^sales-agent:[^:]+$/, fields: {} },
  { key: /^agent:[^:]+:[^:]+$/, fields: {} },
  { key: /^campaign:[^:]+$/, fields: {} },
];

function safeValues(key: string, values: Record<string, unknown>, fields: FieldDef[]): FormValues {
  const policy = POLICIES.find((entry) => entry.key.test(key))?.fields ?? {};
  const available = new Map(fields.map((field) => [field.name, field]));
  const safe: FormValues = {};
  for (const [name, value] of Object.entries(values)) {
    const rule = policy[name];
    const field = available.get(name);
    if (!rule || !field || field.sensitive || field.kind === "password") continue;
    if (typeof rule === "object" && field.kind === "select" && typeof value === "string"
      && rule.allowed.includes(value) && field.options?.some((option) => option.value === value)) safe[name] = value;
    if (rule === "toggle" && field.kind === "toggle" && typeof value === "boolean") safe[name] = value;
    if (rule === "hex" && field.kind === "text" && typeof value === "string"
      && /^#[0-9a-fA-F]{6}$/.test(value)) safe[name] = value;
  }
  return safe;
}

function currentKey(key: string): string | null {
  const userId = sessionStorage.getItem(IDENTITY_KEY);
  return userId ? `${SAFE_PREFIX}${userId}:${key}` : null;
}

/** Remove pre-v3 drafts from both stores without retrieving or parsing values. */
export function purgeLegacySensitiveDrafts() {
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(LEGACY_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      try { localStorage.removeItem(key); } catch { /* continue with other keys */ }
    }
  } catch {
    // Storage may be unavailable in private browsing or during SSR.
  }
  try {
    const keys: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(LEGACY_PREFIX) && key !== IDENTITY_KEY && !key.startsWith(SAFE_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      try { sessionStorage.removeItem(key); } catch { /* continue with other keys */ }
    }
  } catch {
    // A blocked store must not prevent the other store from being scrubbed.
  }
}

purgeLegacySensitiveDrafts();

/** Delete only the current tab's safe drafts, without reading draft values. */
export function clearAllSafeDrafts() {
  try {
    const keys: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(SAFE_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      try { sessionStorage.removeItem(key); } catch { /* continue with other keys */ }
    }
  } catch {
    // Blocked storage means the draft feature is unavailable.
  }
}

/** Keep a draft only while the same authenticated user owns this tab. */
export function syncDraftIdentity(userId: string | null) {
  purgeLegacySensitiveDrafts();
  try {
    const previous = sessionStorage.getItem(IDENTITY_KEY);
    if (previous !== userId) clearAllSafeDrafts();
    if (userId) sessionStorage.setItem(IDENTITY_KEY, userId);
    else sessionStorage.removeItem(IDENTITY_KEY);
  } catch {
    clearAllSafeDrafts();
  }
}

export function clearDraft(key: string | undefined) {
  if (!key) return;
  purgeLegacySensitiveDrafts();
  try {
    const scopedKey = currentKey(key);
    if (scopedKey) sessionStorage.removeItem(scopedKey);
  } catch { /* ignore */ }
  try { localStorage.removeItem(LEGACY_PREFIX + key); } catch { /* ignore */ }
}

/** Restore only explicitly allowed, validated values from the current tab. */
export function readDraft(key: string | undefined, fields: FieldDef[]): FormValues | undefined {
  if (!key) return undefined;
  purgeLegacySensitiveDrafts();
  try {
    const scopedKey = currentKey(key);
    if (!scopedKey) return undefined;
    const raw = sessionStorage.getItem(scopedKey);
    if (!raw) return undefined;
    const stored: unknown = JSON.parse(raw);
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
      clearDraft(key);
      return undefined;
    }
    const envelope = stored as { savedAt?: unknown; values?: unknown };
    if (typeof envelope.savedAt !== "number" || envelope.savedAt > Date.now()
      || Date.now() - envelope.savedAt > MAX_AGE_MS || !envelope.values
      || typeof envelope.values !== "object" || Array.isArray(envelope.values)) {
      clearDraft(key);
      return undefined;
    }
    const safe = safeValues(key, envelope.values as Record<string, unknown>, fields);
    const original = envelope.values as Record<string, unknown>;
    if (Object.keys(safe).length !== Object.keys(original).length
      || Object.keys(envelope).length !== 2) {
      // Delete first: quota failure must not leave an unsafe serialized value.
      sessionStorage.removeItem(scopedKey);
      if (Object.keys(safe).length) {
        try { sessionStorage.setItem(scopedKey, JSON.stringify({ savedAt: envelope.savedAt, values: safe })); }
        catch { /* the safe draft is optional */ }
      }
    }
    return Object.keys(safe).length ? safe : undefined;
  } catch {
    clearDraft(key);
    return undefined;
  }
}

/** Write only explicitly allowed, validated fields; never save free text. */
export function writeDraft(key: string | undefined, values: FormValues, fields: FieldDef[]) {
  if (!key) return;
  purgeLegacySensitiveDrafts();
  try {
    const scopedKey = currentKey(key);
    if (!scopedKey) return;
    const safe = safeValues(key, values, fields);
    sessionStorage.removeItem(scopedKey);
    if (Object.keys(safe).length) {
      sessionStorage.setItem(scopedKey, JSON.stringify({ savedAt: Date.now(), values: safe }));
    }
  } catch {
    // Drafts are a convenience, never a requirement.
  }
}
