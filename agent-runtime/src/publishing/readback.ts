/** Read-only account verification after Meta has acknowledged a public write. */
import type { PublishRequest } from "./types.js";

const BASE = "https://graph.facebook.com/v21.0";
const TIMEOUT_MS = 10_000;

export type PublicationReadback = {
  status: "verified" | "unavailable" | "mismatch";
  observedAccountRef: string | null;
  providerUrl: string | null;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function safeUrl(value: unknown, platform: string): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const hosts = platform === "instagram"
      ? new Set(["instagram.com", "www.instagram.com"])
      : new Set(["facebook.com", "www.facebook.com"]);
    return url.protocol === "https:" && hosts.has(url.hostname) ? url.href : null;
  } catch { return null; }
}

/** A failed read is an unknown provider state; the acknowledged post must not be retried. */
export async function readMetaPublication(
  request: Pick<PublishRequest, "platform" | "accountId" | "accessToken">,
  externalId: string, fetchImpl: typeof fetch = fetch,
): Promise<PublicationReadback> {
  const unavailable: PublicationReadback = {
    status: "unavailable", observedAccountRef: null, providerUrl: null,
  };
  if ((request.platform !== "instagram" && request.platform !== "facebook")
    || !/^[A-Za-z0-9_-]+$/.test(externalId)
    || !/^[0-9]+$/.test(request.accountId) || !request.accessToken.trim()) return unavailable;
  const fields = request.platform === "instagram" ? "id,owner,permalink" : "id,from,permalink_url";
  let body: Record<string, unknown> | null;
  try {
    const response = await fetchImpl(
      `${BASE}/${externalId}?fields=${encodeURIComponent(fields)}`,
      { method: "GET", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Authorization: `Bearer ${request.accessToken}` } },
    );
    if (!response.ok) return unavailable;
    body = object(await response.json());
  } catch { return unavailable; }
  if (!body || body.error != null) return unavailable;
  const readId = body.id;
  const owner = request.platform === "instagram" ? body.owner : body.from;
  const observed = typeof owner === "string" ? owner : object(owner)?.id;
  const observedAccountRef = typeof observed === "string" ? observed : null;
  if (typeof readId !== "string" || !readId || !observedAccountRef) return unavailable;
  if (readId !== externalId || observedAccountRef !== request.accountId) {
    return { status: "mismatch", observedAccountRef, providerUrl: null };
  }
  return {
    status: "verified", observedAccountRef,
    providerUrl: safeUrl(request.platform === "instagram" ? body.permalink : body.permalink_url,
      request.platform),
  };
}
