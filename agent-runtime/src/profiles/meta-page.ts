/** Isolated Facebook Page field transport. No scheduled worker imports it. */

const BASE = "https://graph.facebook.com/v27.0";
const TIMEOUT_MS = 30_000;

export class MetaProfileTransportError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = "MetaProfileTransportError";
  }
}

export interface MetaPageFieldRequest {
  accessToken: string;
  pageId: string;
  field: string;
  currentValue: string | null;
  value: string;
  /** Begins the one-shot reservation after provider preflight, just before POST. */
  assertPrewrite: () => Promise<void>;
  fetchImpl?: typeof fetch;
}

const FIELD: Readonly<Record<string, string>> = {
  about: "about",
  website_url: "website",
};

/** Read-only reconciliation for a previously uncertain one-shot write. */
export async function readMetaPageField(input: {
  accessToken: string; pageId: string; field: string; fetchImpl?: typeof fetch;
}): Promise<{ providerRef: string; observedValue: string | null }> {
  const providerField = FIELD[input.field];
  if (!providerField || !/^[0-9]+$/.test(input.pageId) || !input.accessToken) {
    throw new MetaProfileTransportError("An exact supported Page field and credential are required.");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  async function get(path: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchImpl(`${BASE}/${path}`, {
        method: "GET", headers: { Authorization: `Bearer ${input.accessToken}` },
        redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new MetaProfileTransportError("Meta Page reconciliation read did not return an outcome.", true);
    }
    if (!response.ok) throw new MetaProfileTransportError(
      `Meta Page reconciliation read returned ${response.status}.`,
      response.status === 429 || response.status >= 500);
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new MetaProfileTransportError("Meta returned an unreadable Page response.");
    }
    return body;
  }
  const identity = await get("me?fields=id");
  if (identity.id !== input.pageId) {
    throw new MetaProfileTransportError("The credential is not the reviewed Facebook Page token.");
  }
  const page = await get(`${input.pageId}?fields=id%2C${providerField}`);
  if (page.id !== input.pageId) {
    throw new MetaProfileTransportError("Meta returned a different Page during reconciliation.");
  }
  const value = page[providerField];
  if (value !== null && value !== undefined && typeof value !== "string") {
    throw new MetaProfileTransportError("Meta returned an unreadable Page field value.");
  }
  return { providerRef: `facebook_page:${input.pageId}#${input.field}`,
    observedValue: typeof value === "string" ? value : null };
}

export async function updateMetaPageField(request: MetaPageFieldRequest): Promise<{
  providerRef: string; readbackValue: string;
}> {
  const providerField = FIELD[request.field];
  if (!providerField) throw new MetaProfileTransportError(
    `No Facebook Page adapter writes the ${request.field} field.`);
  if (!/^[0-9]+$/.test(request.pageId) || !request.accessToken
    || typeof request.assertPrewrite !== "function"
    || !(request.currentValue === null || typeof request.currentValue === "string")) {
    throw new MetaProfileTransportError("Exact Page, credential, before value and prewrite claim are required.");
  }
  if (!request.value || (request.field === "about" && Array.from(request.value).length > 100)) {
    throw new MetaProfileTransportError("The proposed Facebook Page field exceeds its supported limit.");
  }
  if (request.field === "website_url") {
    let url: URL;
    try { url = new URL(request.value); }
    catch { throw new MetaProfileTransportError("The proposed Page website is not a URL."); }
    if (!(["http:", "https:"].includes(url.protocol)) || !url.hostname) {
      throw new MetaProfileTransportError("The proposed Page website must use HTTP or HTTPS.");
    }
  }

  const fetchImpl = request.fetchImpl ?? fetch;
  const headers = { Authorization: `Bearer ${request.accessToken}` };
  async function get(path: string, afterWrite: boolean): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchImpl(`${BASE}/${path}`, {
        method: "GET", headers, redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      throw new MetaProfileTransportError(
        `Meta ${afterWrite ? "readback" : "preflight"} failed: ${
          cause instanceof Error ? cause.message : String(cause)}`, !afterWrite);
    }
    if (!response.ok) throw new MetaProfileTransportError(
      `Meta ${afterWrite ? "readback" : "preflight"} refused (${response.status}).`,
      !afterWrite && (response.status === 429 || response.status >= 500));
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new MetaProfileTransportError("Meta returned an unreadable Page response.");
    }
    return body;
  }

  // A User or system-user token may be able to read the Page while lacking
  // the intended Page identity. Require the token itself to resolve to it.
  const identity = await get("me?fields=id", false);
  if (identity.id !== request.pageId) {
    throw new MetaProfileTransportError("The reviewed credential is not the exact Facebook Page token.");
  }
  const pagePath = `${request.pageId}?fields=id%2C${providerField}`;
  async function readField(afterWrite: boolean): Promise<string | null> {
    const page = await get(pagePath, afterWrite);
    if (page.id !== request.pageId) {
      throw new MetaProfileTransportError("Meta did not return the reviewed Facebook Page ID.");
    }
    const value = page[providerField!];
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") {
      throw new MetaProfileTransportError("Meta returned an unreadable Page field value.");
    }
    return value;
  }
  if (await readField(false) !== request.currentValue) {
    throw new MetaProfileTransportError("The live Page field differs from the reviewed before value.");
  }
  await request.assertPrewrite();
  let response: Response;
  try {
    response = await fetchImpl(`${BASE}/${request.pageId}`, {
      method: "POST", headers: { ...headers,
        "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ [providerField]: request.value }).toString(),
      redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    throw new MetaProfileTransportError(
      `Meta Page write outcome is uncertain: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!response.ok) {
    throw new MetaProfileTransportError(
      `Meta Page write returned ${response.status}; reconcile the field before another attempt.`);
  }
  const posted = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (posted?.success !== true) {
    throw new MetaProfileTransportError("Meta Page write did not confirm success; reconcile before retrying.");
  }
  const readbackValue = await readField(true);
  if (readbackValue !== request.value) {
    throw new MetaProfileTransportError("Meta Page readback differs from the approved value.");
  }
  return { providerRef: `facebook_page:${request.pageId}#${request.field}`,
    readbackValue: readbackValue! };
}
