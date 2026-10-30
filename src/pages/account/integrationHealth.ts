/** A status label and credential presence are not provider authorization. */
export function integrationCapabilitySummary(
  provider: string,
  status: string,
  tokenExpiresAt: string | null,
  now: number = Date.now(),
): string {
  if (["error", "expired", "revoked"].includes(status)) {
    return "Blocked by integration status. Reconnect or review before any provider action.";
  }
  const expiry = tokenExpiresAt ? Date.parse(tokenExpiresAt) : Number.NaN;
  if (status === "expiring" && (!Number.isFinite(expiry) || expiry <= now)) {
    return "Blocked: an expiring integration needs a known future token expiry.";
  }
  if (!["connected", "active", "expiring"].includes(status)) {
    return "Blocked: this integration status is not recognized as usable.";
  }
  if (Number.isFinite(expiry) && expiry <= now) {
    return "Blocked: the recorded token expiry has passed. Reconnect before use.";
  }
  switch (provider) {
    case "meta":
    case "instagram":
      return "Account identity, required scopes and publish/ads rights are not verified by the token check.";
    case "google_business":
      return "Provider health unknown. Exact location access, OAuth scope and posting rights have not been verified.";
    case "google_ads":
      return "Provider health unknown. OAuth, developer token, customer access and build rights have not been verified.";
    case "resend":
      return "Provider health unknown. This row does not verify the runtime email key, sending domain or send permission.";
    default:
      return "Provider health unknown. No provider-specific account, scope or action check is recorded.";
  }
}
