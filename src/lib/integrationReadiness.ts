/**
 * Read-only onboarding evidence from client_integrations. The released token
 * health worker records a Meta token verdict, but no production path persists
 * account, scope, or action-capability diagnostics. A configured ID or Vault
 * reference is therefore never called verified provider access here.
 */

export type ReadinessState = "blocked" | "unknown";
export type ReadinessCheck = { state: ReadinessState; reason: string };

export interface IntegrationEvidence {
  client_id: string;
  provider: string;
  credential_secret_id: string | null;
  credential_label: string | null;
  ad_account_id: string | null;
  status: string;
  token_expires_at: string | null;
  last_checked_at: string | null;
  ingest_enabled: boolean;
}

export type SyncProvider = "meta" | "instagram";

export interface ProviderReadiness {
  provider: SyncProvider;
  credential: ReadinessCheck;
  account: ReadinessCheck;
  scopes: ReadinessCheck;
  action: ReadinessCheck;
  dailySync: ReadinessCheck;
  overall: ReadinessState;
}

const blocked = (reason: string): ReadinessCheck => ({ state: "blocked", reason });
const unknown = (reason: string): ReadinessCheck => ({ state: "unknown", reason });

const ACCOUNT_ID: Record<SyncProvider, RegExp> = {
  meta: /^act_[0-9]+$/,
  instagram: /^[0-9]+$/,
};

function accountId(row: IntegrationEvidence): string {
  // The paid adapter prefers ad_account_id and only falls back to a label
  // already shaped like an account ID. Instagram uses credential_label.
  const label = row.credential_label?.trim() ?? "";
  return row.provider === "meta" ? (row.ad_account_id?.trim() || label) : label;
}

/** A metadata check only; it does not call a provider or authorize a write. */
export function providerReadiness(
  provider: SyncProvider,
  integrations: readonly IntegrationEvidence[],
  clientId: string,
  now = Date.now(),
): ProviderReadiness {
  const matches = integrations.filter((row) => row.client_id === clientId && row.provider === provider);
  const missing = matches.length === 0;
  const ambiguous = matches.length > 1;
  const row = matches[0];

  let credential: ReadinessCheck;
  if (missing) credential = blocked(`No ${provider} integration is visible for this client. Ask an admin to connect or verify it.`);
  else if (ambiguous) credential = blocked(`Multiple ${provider} rows make the client/provider credential ambiguous. Resolve duplicates before use.`);
  else if (!row.credential_secret_id) credential = blocked(`No Vault credential reference is recorded for ${provider}.`);
  else if (["error", "expired", "revoked"].includes(row.status)) credential = blocked(`${provider} status is ${row.status}; reconnect or review the grant.`);
  else if (row.status === "expiring") credential = blocked(`${provider} is expiring. The released credential loader does not accept this state until the held B014 contract is released.`);
  else if (!["connected", "active"].includes(row.status)) credential = blocked(`${provider} status is not recognized as usable.`);
  else if (row.token_expires_at && (!Number.isFinite(Date.parse(row.token_expires_at)) || Date.parse(row.token_expires_at) <= now)) {
    credential = blocked(`${provider} has an expired or invalid recorded token expiry.`);
  } else {
    credential = unknown(`A Vault reference and ${row.status} status are recorded. Current token validity is not established by this checklist.`);
  }

  let account: ReadinessCheck;
  if (missing || ambiguous) account = blocked(`There is no unambiguous ${provider} account to check.`);
  else {
    const id = accountId(row);
    account = !ACCOUNT_ID[provider].test(id)
      ? blocked(provider === "meta"
        ? "A Meta ad account ID shaped like act_123 is required."
        : "A numeric Instagram user ID is required.")
      : unknown(`Account ${id} is configured, but no provider account readback is recorded.`);
  }

  const scopes = missing || ambiguous
    ? blocked(`There is no unambiguous ${provider} grant to inspect.`)
    : unknown(`Required ${provider} scopes have no persisted provider-specific diagnostic.`);
  const action = missing || ambiguous
    ? blocked(`There is no unambiguous ${provider} destination for an action.`)
    : unknown(`Publish, ads, and spend rights are unverified; every external action still needs exact-version Approval Inbox approval and execution preflight.`);
  const dailySync = missing || ambiguous
    ? blocked(`No unambiguous ${provider} daily metrics source is configured.`)
    : !row.ingest_enabled
      ? blocked(`Daily ${provider} metrics sync is off.`)
      : credential.state === "blocked" || account.state === "blocked"
        ? blocked(`Daily ${provider} metrics sync is configured on, but the credential or account is blocked; it cannot be treated as runnable.`)
        : unknown(`Daily ${provider} metrics sync is configured on, but account and scope access are unverified.`);

  const checks = [credential, account, scopes, action, dailySync];
  return {
    provider, credential, account, scopes, action, dailySync,
    overall: checks.some((check) => check.state === "blocked") ? "blocked" : "unknown",
  };
}

export function integrationRowsAreValid(value: unknown, clientId: string): value is IntegrationEvidence[] {
  if (!Array.isArray(value)) return false;
  return value.every((row: unknown) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) return false;
    const r = row as Record<string, unknown>;
    return r.client_id === clientId
      && typeof r.provider === "string"
      && typeof r.status === "string"
      && typeof r.ingest_enabled === "boolean"
      && ["credential_secret_id", "credential_label", "ad_account_id", "token_expires_at", "last_checked_at"]
        .every((key) => r[key] === null || typeof r[key] === "string");
  });
}
