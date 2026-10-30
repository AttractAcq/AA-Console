/**
 * Opt-in, read-only provider diagnostics for a controlled connection pilot.
 *
 * Nothing in the scheduled token-health worker imports this module. A caller
 * must supply a fetch implementation and a credential explicitly; these
 * functions never read Vault, update integration status, refresh a token, or
 * perform an external write. A successful read proves only the named read
 * capability, not permission to publish, send, or spend.
 */

import { readTokenHealth } from "./health.js";
import { evaluateProviderCapability, type ProviderCapabilityDecision,
  type ProviderCapabilityKey, type ProviderCapabilityEvidence,
  type CapabilityEvidenceSource, type LocalCredentialState } from "./provider-capability.js";

export type DiagnosticState = "verified" | "blocked" | "unknown";
export type DiagnosticCheck = { state: DiagnosticState; reason: string };

export interface ProviderDiagnostic {
  provider: string;
  checkedAt: string;
  token: DiagnosticCheck;
  app: DiagnosticCheck;
  scopes: DiagnosticCheck;
  account: DiagnosticCheck;
  action: DiagnosticCheck;
  expiresAt: string | null;
  /** Scoped verdict for the requested action; only an exact read can verify. */
  capability: ProviderCapabilityDecision;
}

type BaseRequest = {
  accessToken: string;
  /** Supplied from the exact authorized integration/credential row by a caller. */
  capabilityKey: ProviderCapabilityKey;
  /** Unknown and revoked local rows are never probed or verified. */
  credentialState: LocalCredentialState;
  /** Required, so this code has no ambient network path. */
  fetchImpl: typeof fetch;
  now?: () => number;
};

export type ProviderProbeRequest = BaseRequest & (
  | {
    provider: "meta" | "instagram";
    /** Meta uses act_<digits>; Instagram uses its numeric user ID. */
    expectedAccountId: string | null;
    /** Required scopes for the intended operation, supplied by its caller. */
    requiredScopes: readonly string[];
    expectedAppId: string | null;
  }
  | { provider: "google_business"; expectedLocationRef: string | null }
  | { provider: string }
);

const ok = (reason: string): DiagnosticCheck => ({ state: "verified", reason });
const blocked = (reason: string): DiagnosticCheck => ({ state: "blocked", reason });
const unknown = (reason: string): DiagnosticCheck => ({ state: "unknown", reason });

function blank(provider: string, now: number, key: ProviderCapabilityKey): ProviderDiagnostic {
  return {
    provider,
    checkedAt: new Date(now).toISOString(),
    token: unknown("No provider token verdict was obtained."),
    app: unknown("Provider app identity was not verified."),
    scopes: unknown("Required provider scopes were not verified."),
    account: unknown("The exact destination account was not verified."),
    action: unknown("A read-only probe cannot establish publish, send, or spend permission."),
    expiresAt: null,
    capability: evaluateProviderCapability(key, null, now),
  };
}

function withCapability(
  request: ProviderProbeRequest,
  result: ProviderDiagnostic,
  now: number,
  probedAccountRef: string | null,
  source: CapabilityEvidenceSource = "provider_read_probe",
): ProviderDiagnostic {
  if (probedAccountRef === null) return result;
  // This exact binding is local caller context, not a provider assertion of
  // client or credential identity. A future production caller must obtain it
  // from the authorized integration row and the same credential generation.
  const evidence: ProviderCapabilityEvidence = {
    key: { ...request.capabilityKey, provider: request.provider, accountRef: probedAccountRef },
    source,
    observedAt: result.checkedAt,
    ttlMs: 60_000,
    credentialState: request.credentialState,
    tokenExpiresAt: result.expiresAt,
    checks: {
      token: result.token.state,
      app: result.app.state,
      scopes: result.scopes.state,
      account: result.account.state,
    },
  };
  result.capability = evaluateProviderCapability(request.capabilityKey, evidence, now);
  return result;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

async function jsonResponse(response: Response): Promise<Record<string, unknown> | null> {
  return object(await response.json().catch(() => null));
}

function metaAccountShape(provider: string, id: string): boolean {
  return provider === "meta" ? /^act_[0-9]+$/.test(id) : /^[0-9]+$/.test(id);
}

async function probeMeta(
  request: BaseRequest & { provider: "meta" | "instagram"; expectedAccountId: string | null;
    requiredScopes: readonly string[]; expectedAppId: string | null },
  result: ProviderDiagnostic,
  now: number,
): Promise<ProviderDiagnostic> {
  const token = request.accessToken.trim();
  if (!token) {
    result.token = blocked("No credential was supplied for the diagnostic.");
    return result;
  }
  const accountId = request.expectedAccountId?.trim() ?? "";
  if (accountId && !metaAccountShape(request.provider, accountId)) {
    result.account = blocked("The configured account ID has the wrong shape for this provider.");
    return result;
  }

  try {
    // Meta's debug_token endpoint accepts an input token and an app access
    // token. This first-party path mirrors the existing daily check. No URL,
    // response body, token, or Authorization header is ever logged or returned.
    const query = new URLSearchParams({ input_token: token, access_token: token });
    const response = await request.fetchImpl(`https://graph.facebook.com/v21.0/debug_token?${query}`, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    const body = await jsonResponse(response);
    const error = object(body?.error);
    if (!response.ok) {
      result.token = response.status === 400 && Number(error?.code) === 190
        ? blocked("Meta reported an invalid OAuth token.")
        : unknown(`Meta token diagnostic returned HTTP ${response.status}; validity is unknown.`);
      return result;
    }

    const verdict = readTokenHealth(body, now);
    result.expiresAt = verdict.expiresAt;
    result.token = verdict.usable
      ? ok("Meta reported this token valid at diagnostic time.")
      : blocked("Meta reported this token invalid or expired.");
    if (!verdict.usable) return result;

    const data = object(body?.data);
    const appId = data?.app_id;
    result.app = request.expectedAppId
      ? appId == null
        ? unknown("Meta did not return an app ID to compare.")
        : String(appId) === request.expectedAppId
          ? ok("Meta app ID matches the expected app.")
          : blocked("Meta app ID does not match the expected app.")
      : unknown("No expected Meta app ID was supplied.");
    if (result.app.state === "blocked") return result;

    const expected = request.requiredScopes.map((scope) => scope.trim()).filter(Boolean);
    const scopes = data?.scopes;
    result.scopes = expected.length === 0
      ? unknown("No operation-specific Meta scopes were supplied for comparison.")
      : !Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")
        ? unknown("Meta did not return a usable scope list.")
        : expected.every((scope) => scopes.includes(scope))
          ? ok("Meta reports every requested scope; target-level grants still need action preflight.")
          : blocked("Meta did not report every required scope.");
    if (result.scopes.state === "blocked") return result;

    if (!accountId) {
      result.account = unknown("No exact account ID was supplied for readback.");
      return result;
    }
    const accountResponse = await request.fetchImpl(
      `https://graph.facebook.com/v21.0/${accountId}?fields=id`, {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    const accountBody = await jsonResponse(accountResponse);
    if (!accountResponse.ok) {
      result.account = [400, 401, 403, 404].includes(accountResponse.status)
        ? blocked("Meta refused a read of the configured account.")
        : unknown(`Meta account read returned HTTP ${accountResponse.status}; access is unknown.`);
      return result;
    }
    if (accountBody?.error != null) {
      result.account = unknown("Meta account read returned an error envelope without a reliable account verdict.");
      return result;
    }
    result.account = typeof accountBody?.id === "string"
      ? accountBody.id === accountId
        ? ok("The configured Meta account returned its exact ID on a read.")
        : blocked("Meta returned a different account ID.")
      : unknown("Meta account read did not return an ID.");
    return result;
  } catch {
    // Includes transport failures and malformed/unknown Meta verdicts. Do not
    // infer revocation from a failed diagnostic or include provider body text.
    return result;
  }
}

const LOCATION_REF = /^accounts\/[A-Za-z0-9_-]+\/locations\/[A-Za-z0-9_-]+$/;

async function probeGoogleBusiness(
  request: BaseRequest & { expectedLocationRef: string | null },
  result: ProviderDiagnostic,
): Promise<ProviderDiagnostic> {
  const token = request.accessToken.trim();
  const ref = request.expectedLocationRef?.trim() ?? "";
  if (!token) {
    result.token = blocked("No credential was supplied for the diagnostic.");
    return result;
  }
  if (!LOCATION_REF.test(ref)) {
    result.account = blocked("No valid exact Business Profile location was supplied.");
    return result;
  }

  try {
    // The existing GBP writer uses this v4 resource. A successful GET proves
    // read access to the exact location; it does not prove localPosts.create.
    const response = await request.fetchImpl(`https://mybusiness.googleapis.com/v4/${ref}`, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await jsonResponse(response);
    if (!response.ok) {
      result.account = [400, 401, 403, 404].includes(response.status)
        ? blocked("Google refused a read of the configured Business Profile location.")
        : unknown(`Business Profile location read returned HTTP ${response.status}; access is unknown.`);
      return result;
    }
    if (body?.error != null) {
      result.account = unknown("Business Profile read returned an error envelope without a reliable location verdict.");
      return result;
    }
    if (body?.name === ref) {
      result.token = ok("Google accepted this token for the exact location read.");
      result.account = ok("The configured Business Profile location returned its exact resource name.");
      result.scopes = unknown("Location read access does not prove posting permission or all intended scopes.");
    } else {
      result.account = typeof body?.name === "string"
        ? blocked("Google returned a different Business Profile location.")
        : unknown("Business Profile location read did not return its resource name.");
    }
    return result;
  } catch {
    return result;
  }
}

/**
 * An explicit diagnostic entry point, with no production caller yet. Keep
 * Google Ads, Resend, and generic Google unknown: their present credential
 * and account models cannot establish per-client action rights from a safe
 * read, and a Resend sending-only key may have no read/list permission.
 */
export async function probeProvider(request: ProviderProbeRequest): Promise<ProviderDiagnostic> {
  const now = request.now?.() ?? Date.now();
  const result = blank(request.provider, now, request.capabilityKey);
  if (request.credentialState !== "eligible") {
    return withCapability(request, result, now, request.capabilityKey.accountRef, "configured_metadata");
  }
  if (request.provider === "meta" || request.provider === "instagram") {
    const meta = request as BaseRequest & { provider: "meta" | "instagram";
      expectedAccountId: string | null; requiredScopes: readonly string[]; expectedAppId: string | null };
    const diagnostic = await probeMeta(meta, result, now);
    return withCapability(request, diagnostic, request.now?.() ?? Date.now(),
      meta.expectedAccountId?.trim() ?? "");
  }
  if (request.provider === "google_business") {
    const google = request as BaseRequest & { expectedLocationRef: string | null };
    const diagnostic = await probeGoogleBusiness(google, result);
    return withCapability(request, diagnostic, request.now?.() ?? Date.now(),
      google.expectedLocationRef?.trim() ?? "");
  }
  result.token = unknown(
    request.provider === "resend"
      ? "A sending-only Resend key cannot certify send rights through a read/list probe."
      : request.provider === "google_ads"
        ? "Google Ads OAuth, developer token, and exact customer access need a separate controlled probe."
        : "No provider-specific read-only diagnostic exists for this provider.",
  );
  return result;
}
