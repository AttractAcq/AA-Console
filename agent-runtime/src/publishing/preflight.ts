/** Read-only Meta checks immediately before an approved public write. */
import { readTokenHealth } from "../agents/token_health/health.js";
import { PublishError } from "./types.js";

const BASE = "https://graph.facebook.com/v21.0";
const TIMEOUT_MS = 10_000;

export type PublishPreflightRequest = {
  platform: "instagram" | "facebook";
  accountId: string;
  accessToken: string;
  expectedAppId: string | null;
  fetchImpl?: typeof fetch;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

async function read(
  fetchImpl: typeof fetch, url: string, accessToken?: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
    });
  } catch {
    // The debug-token URL contains a secret. Never include an exception or URL.
    throw new PublishError("Provider publication preflight read failed.", true);
  }
  if (!response.ok) throw new PublishError(
    `Provider publication preflight returned HTTP ${response.status}.`,
    response.status === 429 || response.status >= 500);
  const body = object(await response.json().catch(() => null));
  if (!body || body.error != null) {
    throw new PublishError("Provider publication preflight returned no reliable result.", false);
  }
  return body;
}

/**
 * A successful result establishes the listed read prerequisites at this time.
 * It cannot prove that Meta will accept a later POST, so the publication
 * receipt and account read-back remain separate gates.
 */
export async function assertMetaPublishPrerequisites(input: PublishPreflightRequest): Promise<void> {
  const { platform, accountId, accessToken, expectedAppId } = input;
  if (!/^[0-9]+$/.test(accountId) || !accessToken.trim()
    || !expectedAppId?.trim()) {
    throw new PublishError("Publication account, credential and Meta app ID are required.", false);
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const query = new URLSearchParams({ input_token: accessToken, access_token: accessToken });
  const debug = await read(fetchImpl, `${BASE}/debug_token?${query}`);
  let valid: boolean;
  try { valid = readTokenHealth(debug).usable; }
  catch { throw new PublishError("Meta token validity is unknown.", false); }
  if (!valid) throw new PublishError("Meta reported an invalid or expired publication token.", false);
  const data = object(debug.data);
  if (String(data?.app_id ?? "") !== expectedAppId) {
    throw new PublishError("Publication token belongs to another Meta app.", false);
  }
  const required = platform === "instagram"
    ? ["instagram_basic", "instagram_content_publish", "pages_read_engagement"]
    : ["pages_manage_posts", "pages_read_engagement", "pages_show_list"];
  const scopes = data?.scopes;
  if (!Array.isArray(scopes) || required.some((scope) => !scopes.includes(scope))) {
    throw new PublishError("Publication token lacks required Meta scopes.", false);
  }

  const account = await read(fetchImpl, `${BASE}/${accountId}?fields=id`, accessToken);
  if (account.id !== accountId) {
    throw new PublishError("Meta did not confirm the exact publication account.", false);
  }
  if (platform === "facebook") {
    const identity = await read(fetchImpl, `${BASE}/me?fields=id`, accessToken);
    if (identity.id !== accountId) {
      throw new PublishError("The credential is not the exact Facebook Page token.", false);
    }
    const page = await read(fetchImpl, `${BASE}/${accountId}?fields=id%2Ctasks`, accessToken);
    if (page.id !== accountId || !Array.isArray(page.tasks)
      || !page.tasks.some((task) => task === "CREATE_CONTENT" || task === "MANAGE")) {
      throw new PublishError("The Facebook Page did not confirm a content task.", false);
    }
  } else {
    const limit = await read(fetchImpl,
      `${BASE}/${accountId}/content_publishing_limit`, accessToken);
    if (!Array.isArray(limit.data)) {
      throw new PublishError("Instagram publishing-limit read was not confirmed.", false);
    }
  }
}
