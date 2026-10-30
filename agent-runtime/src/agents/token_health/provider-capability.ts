/**
 * Pure, short-lived interpretation of provider evidence for one exact client,
 * integration row, credential generation, destination and action. This is an
 * evidence contract, not an authorization check or permission to execute.
 * Only a direct read diagnostic can verify one of the three implemented read
 * actions. Metadata, generic connection health and any write action cannot.
 */

export type CapabilityState = "verified" | "blocked" | "unknown";
export type CapabilityEvidenceSource =
  | "provider_read_probe"
  | "configured_metadata"
  | "provider_action_preflight";
export type LocalCredentialState = "eligible" | "revoked" | "unknown";

export interface ProviderCapabilityKey {
  clientId: string;
  integrationId: string;
  /** An opaque, nonsecret identifier that changes on every credential rotation. */
  credentialVersion: string;
  provider: string;
  /** The exact ad account, Instagram account, or Business Profile location. */
  accountRef: string;
  actionKey: string;
}

export interface ProviderCapabilityEvidence {
  key: ProviderCapabilityKey;
  source: CapabilityEvidenceSource;
  observedAt: string;
  ttlMs: number;
  /** The caller's current exact-row status, not a provider response field. */
  credentialState: LocalCredentialState;
  tokenExpiresAt: string | null;
  checks: {
    token: CapabilityState;
    app: CapabilityState;
    scopes: CapabilityState;
    account: CapabilityState;
  };
}

export type CapabilityReason =
  | "missing_evidence"
  | "invalid_scope"
  | "scope_mismatch"
  | "credential_revoked"
  | "credential_state_unknown"
  | "invalid_evidence_time"
  | "stale_evidence"
  | "credential_expired"
  | "metadata_only"
  | "unimplemented_source"
  | "unimplemented_action"
  | "provider_denied"
  | "provider_uncertain"
  | "exact_read_verified";

export interface ProviderCapabilityDecision {
  key: ProviderCapabilityKey;
  state: CapabilityState;
  reason: CapabilityReason;
  observedAt: string | null;
  /** Freshness bound on the evidence, never a grant to perform an action. */
  evidenceFreshUntil: string | null;
}

/** No caller may extend this list by supplying a scope or a status string. */
const IMPLEMENTED_READ_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  meta: "meta.account.read",
  instagram: "instagram.account.read",
  google_business: "google_business.location.read",
});

export const MAX_CAPABILITY_EVIDENCE_TTL_MS = 5 * 60_000;

const KEY_FIELDS = [
  "clientId", "integrationId", "credentialVersion", "provider", "accountRef", "actionKey",
] as const satisfies readonly (keyof ProviderCapabilityKey)[];
const ZONED_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function parseZonedTime(value: unknown): number | null {
  if (typeof value !== "string" || !ZONED_TIMESTAMP.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function isNonemptyKey(key: unknown): key is ProviderCapabilityKey {
  if (key === null || typeof key !== "object" || Array.isArray(key)) return false;
  const record = key as Record<string, unknown>;
  return KEY_FIELDS.every((field) => typeof record[field] === "string" &&
    (record[field] as string).trim().length > 0);
}

function decision(
  key: ProviderCapabilityKey,
  state: CapabilityState,
  reason: CapabilityReason,
  observedAt: string | null = null,
  evidenceFreshUntil: string | null = null,
): ProviderCapabilityDecision {
  // Pick only the declared nonsecret fields. A caller may pass an object with
  // extra properties at runtime; spreading it would echo a credential through
  // both positive and fail-closed diagnostic responses.
  const candidate = key && typeof key === "object"
    ? key as unknown as Record<string, unknown> : {};
  const publicKey: ProviderCapabilityKey = {
    clientId: typeof candidate.clientId === "string" ? candidate.clientId : "",
    integrationId: typeof candidate.integrationId === "string" ? candidate.integrationId : "",
    credentialVersion: typeof candidate.credentialVersion === "string" ? candidate.credentialVersion : "",
    provider: typeof candidate.provider === "string" ? candidate.provider : "",
    accountRef: typeof candidate.accountRef === "string" ? candidate.accountRef : "",
    actionKey: typeof candidate.actionKey === "string" ? candidate.actionKey : "",
  };
  return { key: publicKey, state, reason, observedAt, evidenceFreshUntil };
}

/**
 * Evaluate one evidence item against the action being considered. The caller
 * must source the key from its authorized integration and credential lookup;
 * passing a forged `provider_read_probe` object does not prove provenance.
 */
export function evaluateProviderCapability(
  requested: ProviderCapabilityKey,
  evidence: ProviderCapabilityEvidence | null,
  now: number,
): ProviderCapabilityDecision {
  if (!isNonemptyKey(requested)) return decision(requested, "unknown", "invalid_scope");
  if (!evidence) return decision(requested, "unknown", "missing_evidence");
  if (!isNonemptyKey(evidence.key) || KEY_FIELDS.some((field) => requested[field] !== evidence.key[field])) {
    return decision(requested, "blocked", "scope_mismatch");
  }
  if (evidence.credentialState === "revoked") {
    return decision(requested, "blocked", "credential_revoked");
  }
  if (evidence.credentialState !== "eligible") {
    return decision(requested, "unknown", "credential_state_unknown");
  }

  const observed = parseZonedTime(evidence.observedAt);
  if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime()) ||
      observed === null || observed > now ||
      !Number.isSafeInteger(evidence.ttlMs) || evidence.ttlMs <= 0 ||
      evidence.ttlMs > MAX_CAPABILITY_EVIDENCE_TTL_MS) {
    return decision(requested, "unknown", "invalid_evidence_time");
  }
  const observedAt = new Date(observed).toISOString();
  const expires = observed + evidence.ttlMs;
  if (!Number.isSafeInteger(expires) || !Number.isFinite(new Date(expires).getTime()) || now >= expires) {
    return decision(requested, "unknown", "stale_evidence", observedAt);
  }
  const tokenExpiry = evidence.tokenExpiresAt === null ? null : parseZonedTime(evidence.tokenExpiresAt);
  if (evidence.tokenExpiresAt !== null && tokenExpiry === null) {
    return decision(requested, "unknown", "invalid_evidence_time", observedAt);
  }
  if (tokenExpiry !== null && now >= tokenExpiry) {
    return decision(requested, "blocked", "credential_expired", observedAt);
  }
  const evidenceFreshUntil = new Date(Math.min(expires, tokenExpiry ?? expires)).toISOString();

  if (evidence.source === "configured_metadata") {
    return decision(requested, "unknown", "metadata_only", observedAt, evidenceFreshUntil);
  }
  if (evidence.source !== "provider_read_probe") {
    return decision(requested, "unknown", "unimplemented_source", observedAt, evidenceFreshUntil);
  }
  if (IMPLEMENTED_READ_ACTIONS[requested.provider] !== requested.actionKey) {
    return decision(requested, "unknown", "unimplemented_action", observedAt, evidenceFreshUntil);
  }

  if (evidence.checks === null || typeof evidence.checks !== "object") {
    return decision(requested, "unknown", "provider_uncertain", observedAt, evidenceFreshUntil);
  }

  const required: CapabilityState[] = requested.provider === "google_business"
    ? [evidence.checks.token, evidence.checks.account]
    : [evidence.checks.token, evidence.checks.app, evidence.checks.scopes, evidence.checks.account];
  if (required.includes("blocked")) {
    return decision(requested, "blocked", "provider_denied", observedAt, evidenceFreshUntil);
  }
  if (required.some((check) => check !== "verified")) {
    return decision(requested, "unknown", "provider_uncertain", observedAt, evidenceFreshUntil);
  }
  return decision(requested, "verified", "exact_read_verified", observedAt, evidenceFreshUntil);
}
