/**
 * What Meta's debug_token says about a token, as a state this system uses.
 *
 * M1.2. Split from the agent so it can be tested against the shapes Meta
 * actually returns rather than against a mock of our own idea of them.
 *
 * A Meta debug response only describes token validity and expiry. It cannot
 * establish that the integration still owns the right account or scopes, so
 * it must not reactivate a disabled integration.
 */

/** The integration states relevant to token health. */
export type IntegrationStatus = "connected" | "active" | "expiring" | "error" | "expired" | "revoked";

/** A token inside this many days of expiry is worth warning about. */
export const EXPIRING_WITHIN_DAYS = 7;

export interface TokenVerdict {
  status: IntegrationStatus;
  /** One line for the Integrations panel. Always set, including when healthy. */
  detail: string;
  expiresAt: string | null;
  /** Whether Meta reports this token as currently valid, not full provider authorization. */
  usable: boolean;
}

interface DebugTokenData {
  is_valid?: unknown;
  expires_at?: unknown;
  data_access_expires_at?: unknown;
  scopes?: unknown;
  error?: { message?: unknown; code?: unknown } | null;
}

/** Meta returns seconds, and 0 for "never expires". */
function expiryOf(value: unknown): number | null {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds * 1000;
}

/**
 * Read a debug_token payload.
 *
 * `now` is injected so a test can sit a fixed distance from an expiry rather
 * than computing one from the clock it is running on, which is the
 * difference between a test that pins the boundary and one that drifts
 * across it.
 */
export function readTokenHealth(payload: unknown, now: number = Date.now()): TokenVerdict {
  const envelope = payload && typeof payload === "object" ? payload as { data?: unknown; error?: unknown } : null;
  const data = envelope?.data && typeof envelope.data === "object" ? envelope.data as DebugTokenData : null;
  const topError = envelope?.error && typeof envelope.error === "object"
    ? envelope.error as { message?: unknown; code?: unknown } : null;
  const innerError = data?.error && typeof data.error === "object" ? data.error : null;
  const authError = [innerError, topError].find((error) => Number(error?.code) === 190);
  const nonAuthError = [innerError, topError].find((error) =>
    error?.code != null && Number(error.code) !== 190);

  // A Meta OAuth error or explicit false is evidence that the credential is
  // invalid. Any other error, missing data, or unknown validity is a failed
  // probe, not a reason to revoke a working integration.
  if (nonAuthError) {
    throw new Error("Meta debug_token returned a non-auth error; token validity is unknown.");
  }
  if (authError || data?.is_valid === false) {
    return {
      status: "error",
      // Provider error strings are untrusted and may echo credential bytes.
      detail: "Meta says this token is no longer valid. Reconnect the integration to replace it.",
      expiresAt: null,
      usable: false,
    };
  }
  if (!data || data.is_valid !== true || innerError || topError) {
    throw new Error("Meta debug_token did not establish token validity.");
  }

  // Two clocks: the token's own expiry, and when data access lapses. The
  // nearer one is the one that bites, and they are often different — a
  // long-lived token with sixty-day data access stops returning insights
  // while still reporting itself valid.
  const candidates = [expiryOf(data.expires_at), expiryOf(data.data_access_expires_at)].filter(
    (value): value is number => value !== null,
  );
  const expiresAtMs = candidates.length > 0 ? Math.min(...candidates) : null;
  const expiresAt = expiresAtMs === null ? null : new Date(expiresAtMs).toISOString();

  if (expiresAtMs !== null && expiresAtMs <= now) {
    return {
      status: "error",
      detail: "This token has expired. Reconnect the integration to replace it.",
      expiresAt,
      usable: false,
    };
  }

  if (expiresAtMs !== null) {
    const days = Math.floor((expiresAtMs - now) / 86_400_000);
    if (days <= EXPIRING_WITHIN_DAYS) {
      return {
        status: "expiring",
        // Still usable, deliberately. An integration that stops working a
        // week early because it was *going* to stop working is the warning
        // causing the outage.
        detail: `This token expires in ${days === 0 ? "under a day" : `${days} day${days === 1 ? "" : "s"}`}. Reconnect before it does.`,
        expiresAt,
        usable: true,
      };
    }
  }

  return {
    status: "connected",
    detail: expiresAt
      ? "Meta reports this token valid; account and required permissions are not verified."
      : "Meta reports this token valid; no expiry date was established, and account and required permissions are not verified.",
    expiresAt,
    usable: true,
  };
}

/**
 * The status to write, given what the token says and where the integration is.
 *
 * A valid Meta token does not prove the expected account or permission set.
 * Therefore this worker can only preserve a usable state or demote one on a
 * definitive invalid response. A terminal state needs a new credential or
 * guarded operator review. In particular, do not write `expiring` from a
 * usable state: released SQL still rejects it until migration 291 is applied.
 */
export function statusToWrite(current: string, verdict: TokenVerdict): IntegrationStatus {
  if (current === "error" || current === "expired" || current === "revoked") return current;
  if (current !== "connected" && current !== "active" && current !== "expiring") return "error";
  if (!verdict.usable) return "error";
  return current;
}
