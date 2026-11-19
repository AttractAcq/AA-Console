/**
 * Putting a cleared piece of proof on a client's Google Business Profile.
 *
 * The one genuinely new transport in proof distribution. Everything else on
 * the destination list is either a person placing something by hand, a page
 * pipeline publishing bytes, or Meta -- which this system already talks to.
 *
 * WHAT THIS IS AND IS NOT PROVEN TO DO
 *
 * The call below is the Business Profile local-posts endpoint, which is
 * where a post on a profile actually comes from. It has not been run against
 * a real profile, because no client in this system has a connected Google
 * Business credential yet. Migration 231 therefore leaves the destination
 * gated behind `requires_integration`, so the due view says "No usable
 * google_business integration for this client" and nothing is claimed. When
 * a credential exists, the acceptance gate is a post appearing on a real
 * profile with its external id recorded -- not this file existing.
 *
 * RETRYABLE IS A NARROW WORD
 *
 * A proof post on a public profile cannot be unposted. So only the failures
 * that certainly happened before the write are retryable: a rate limit, a
 * server error, a network fault with no response. Anything that came back
 * with a 4xx the API chose deliberately -- a revoked token, a location the
 * credential cannot see, a payload it rejected -- is permanent until a
 * person changes something, and retrying it three times is three identical
 * refusals in the log pretending to be diligence.
 */

/** Google's own limit on a local post's summary. */
export const SUMMARY_LIMIT = 1500;

const API_BASE = "https://mybusiness.googleapis.com/v4";
const LOCATION_API_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1";
const LOCATION_LIST_API_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1alpha";
const ACCOUNT_API_BASE = "https://mybusinessaccountmanagement.googleapis.com/v1";
/** Long enough for a slow API, short enough that a sweep's lease outlives it. */
const TIMEOUT_MS = 30_000;

export class PlacementTransportError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean = false,
    /** A public POST may have taken effect; never queue another POST automatically. */
    readonly uncertain: boolean = false,
    readonly externalId: string | null = null,
  ) {
    super(message);
    this.name = "PlacementTransportError";
  }
}

export interface LocalPostRequest {
  /** The token, already read from the Vault. This file never touches the database. */
  readonly accessToken: string;
  /**
   * The profile location, as Google addresses it:
   * `accounts/{account}/locations/{location}`. Stored per client in
   * `client_proof_destinations.account_ref`, which is a handle and never a
   * credential.
   */
  readonly accountRef: string;
  /** The words. Already the exact approved payload; this only length-checks them. */
  readonly summary: string;
  /** A publicly fetchable image URL, where the placement carries media. */
  readonly mediaUrl?: string | null;
  /** Where a reader should end up. A campaign page, usually. */
  readonly linkUrl?: string | null;
  /** Injected in tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export interface LocalPostResult {
  /** Google's own name for the post: `accounts/a/locations/l/localPosts/p`. */
  readonly externalId: string;
  readonly externalUrl: string | null;
}

/** `accounts/123/locations/456`, and nothing else. */
const ACCOUNT_REF = /^accounts\/[A-Za-z0-9_-]+\/locations\/[A-Za-z0-9_-]+$/;

function safeSearchUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && (url.hostname === "google.com" || url.hostname.endsWith(".google.com")
        || url.hostname === "g.co" || url.hostname === "g.page")
      ? url.href : null;
  } catch { return null; }
}

export async function createLocalPost(request: LocalPostRequest): Promise<LocalPostResult> {
  const accountRef = (request.accountRef ?? "").trim();
  if (!ACCOUNT_REF.test(accountRef)) {
    throw new PlacementTransportError(
      `"${accountRef || "nothing"}" is not a Business Profile location. It should read accounts/<account>/locations/<location>.`,
      false,
    );
  }
  const summary = (request.summary ?? "").trim();
  if (summary.length === 0) {
    throw new PlacementTransportError("This placement has no words to post.", false);
  }
  if (summary.length > SUMMARY_LIMIT) {
    // Truncating would publish something nobody approved, which is the one
    // thing this whole module exists to prevent.
    throw new PlacementTransportError(
      `This payload is ${summary.length} characters and a profile post takes ${SUMMARY_LIMIT}. Shorten the approved version rather than letting it be cut.`,
      false,
    );
  }

  const body: Record<string, unknown> = {
    languageCode: "en",
    summary,
    topicType: "STANDARD",
    ...(request.mediaUrl
      ? { media: [{ mediaFormat: "PHOTO", sourceUrl: request.mediaUrl }] }
      : {}),
    ...(request.linkUrl
      ? { callToAction: { actionType: "LEARN_MORE", url: request.linkUrl } }
      : {}),
  };

  const doFetch = request.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await doFetch(`${API_BASE}/${accountRef}/localPosts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // No response is not evidence that the POST failed. A retry can create a
    // second public post with a new server-assigned ID.
    throw new PlacementTransportError(
      "Business Profile POST outcome is unknown; inspect the location before another attempt.",
      false, true,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    const detail = (text || "no body").slice(0, 500);
    // A timeout, rate limit or server failure after a POST is not proof that
    // no object was created. Explicit other 4xx refusals are known failures.
    const uncertain = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new PlacementTransportError(
      uncertain
        ? `Business Profile POST returned HTTP ${response.status}; inspect the location before another attempt.`
        : `Google Business Profile refused the post (${response.status}): ${detail}`,
      false, uncertain,
    );
  }

  let parsed: { name?: string; searchUrl?: string } | null = null;
  try {
    parsed = text ? (JSON.parse(text) as { name?: string; searchUrl?: string }) : null;
  } catch {
    parsed = null;
  }
  const name = (parsed?.name ?? "").trim();
  if (!name) {
    // Accepted, but with nothing to record. That is worse than a failure:
    // the post may be live and unretractable-by-id. Non-retryable, and the
    // message says to go and look.
    throw new PlacementTransportError(
      "The post was accepted but came back with no id, so there is nothing to record or retract. Check the profile.",
      false, true,
    );
  }
  if (!new RegExp(`^${accountRef}/localPosts/[A-Za-z0-9_-]+$`).test(name)) {
    throw new PlacementTransportError(
      "Business Profile returned a post outside the expected location; inspect the provider account.",
      false, true,
      /^accounts\/[A-Za-z0-9_-]+\/locations\/[A-Za-z0-9_-]+\/localPosts\/[A-Za-z0-9_-]+$/.test(name)
        ? name : null,
    );
  }
  return { externalId: name, externalUrl: safeSearchUrl(parsed?.searchUrl) };
}

/**
 * Changing one field on a Business Profile location — G05.
 *
 * Same honesty as the local post above: this is the real locations endpoint
 * and it has not been run against a real profile, because no client has a
 * connected Google Business credential. The acceptance gate is a field
 * changing on a real profile with its reference recorded.
 *
 * ONE FIELD PER CALL, VIA updateMask
 *
 * Google patches a location against an explicit `updateMask`, and anything
 * omitted from the mask is left alone. Sending the whole location object
 * would mean every unlisted field being overwritten by whatever we happened
 * to have, which is how an adapter silently erases a client's opening hours.
 * So each approved change is one field and one mask entry.
 */

/** The field names Google uses, for the fields we are willing to write. */
const LOCATION_FIELD: Readonly<Record<string, string>> = {
  title: "title",
  description: "profile.description",
  // Google updates the phoneNumbers object as a unit, including additional
  // numbers. The transport preserves those from the provider preflight.
  primary_phone: "phoneNumbers",
  website_url: "websiteUri",
  hours: "regularHours",
};

export interface LocationPatchRequest {
  readonly accessToken: string;
  /** `accounts/{account}/locations/{location}`. */
  readonly accountRef: string;
  /** One of the keys of LOCATION_FIELD. */
  readonly field: string;
  /** The approved value. For `hours` this is a JSON string Google's shape. */
  readonly value: string;
  /** The exact before value shown to the reviewer, or null when absent. */
  readonly currentValue: string | null;
  /** Rechecks the current source decision, credential and one-shot claim. */
  readonly assertPrewrite: () => Promise<void>;
  readonly fetchImpl?: typeof fetch;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function locationFieldValue(location: Record<string, unknown>, field: string): string | null {
  const nested = (key: string) => location[key] as Record<string, unknown> | undefined;
  const value = field === "title" ? location.title
    : field === "description" ? nested("profile")?.description
    : field === "primary_phone" ? nested("phoneNumbers")?.primaryPhone
    : field === "website_url" ? location.websiteUri
    : field === "hours" ? location.regularHours : undefined;
  if (value === null || value === undefined) return null;
  if (field === "hours") return canonicalJson(value);
  if (typeof value !== "string") {
    throw new PlacementTransportError(`Google returned an unreadable ${field} value.`, false);
  }
  return value;
}

function expectedFieldValue(field: string, value: string | null): string | null {
  if (value === null || field !== "hours") return value;
  try { return canonicalJson(JSON.parse(value)); }
  catch { throw new PlacementTransportError("The reviewed current hours are not valid JSON.", false); }
}

/** Read-only merchant-record check for an uncertain location PATCH. */
export async function readVerifiedLocationField(input: {
  accessToken: string; accountRef: string; field: string; fetchImpl?: typeof fetch;
}): Promise<{ externalRef: string; observedValue: string | null }> {
  const mask = LOCATION_FIELD[input.field];
  if (!mask || !ACCOUNT_REF.test(input.accountRef) || !input.accessToken) {
    throw new PlacementTransportError("A supported field, exact account location and credential are required.");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const accountRef = input.accountRef.split("/locations/")[0]!;
  const locationName = `locations/${input.accountRef.split("/")[3]!}`;
  async function get(url: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchImpl(url, { method: "GET",
        headers: { Authorization: `Bearer ${input.accessToken}` },
        redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new PlacementTransportError("Google location reconciliation read did not return an outcome.", true);
    }
    if (!response.ok) throw new PlacementTransportError(
      `Google location reconciliation read returned ${response.status}.`,
      response.status === 429 || response.status >= 500);
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new PlacementTransportError("Google returned an unreadable reconciliation response.");
    }
    return body;
  }
  const account = await get(`${ACCOUNT_API_BASE}/${accountRef}`);
  if (account.name !== accountRef) {
    throw new PlacementTransportError("Google did not confirm the reviewed Business Profile account.");
  }
  let pageToken: string | null = null;
  let member = false;
  for (let page = 0; page < 100 && !member; page += 1) {
    const params = new URLSearchParams({ readMask: "name", pageSize: "100" });
    if (pageToken) params.set("pageToken", pageToken);
    const listing = await get(`${LOCATION_LIST_API_BASE}/${accountRef}/locations?${params}`);
    if (listing.locations !== undefined && (!Array.isArray(listing.locations)
      || listing.locations.some((item) => !item || typeof item !== "object"
        || typeof (item as Record<string, unknown>).name !== "string"))) {
      throw new PlacementTransportError("Google returned an unreadable account location listing.");
    }
    member = ((listing.locations ?? []) as Record<string, unknown>[])
      .some((item) => item.name === locationName);
    if (listing.nextPageToken !== undefined && typeof listing.nextPageToken !== "string") {
      throw new PlacementTransportError("Google returned an unreadable location page token.");
    }
    pageToken = typeof listing.nextPageToken === "string" && listing.nextPageToken
      ? listing.nextPageToken : null;
    if (!member && !pageToken) break;
    if (!member && page === 99) {
      throw new PlacementTransportError("Google location membership exceeded the page limit.");
    }
  }
  if (!member) throw new PlacementTransportError(
    "The location is absent from the reviewed Business Profile account.");
  const location = await get(`${LOCATION_API_BASE}/${locationName}?readMask=${encodeURIComponent(mask)}`);
  if (location.name !== locationName) {
    throw new PlacementTransportError("Google returned a different location during reconciliation.");
  }
  return { externalRef: `${locationName}#${input.field}`,
    observedValue: locationFieldValue(location, input.field) };
}

/** Builds the nested body Google expects for one field. */
export function locationPatchBody(field: string, value: string): Record<string, unknown> {
  switch (field) {
    case "title":
      return { title: value };
    case "description":
      return { profile: { description: value } };
    case "primary_phone":
      return { phoneNumbers: { primaryPhone: value } };
    case "website_url":
      return { websiteUri: value };
    case "hours":
      // Already the shape Google wants, validated by whoever approved it.
      // Parsed here only so a malformed value fails before the call rather
      // than as an opaque 400.
      return { regularHours: JSON.parse(value) as unknown };
    default:
      throw new PlacementTransportError(`No adapter writes the ${field} field.`, false);
  }
}

export async function patchLocationField(
  request: LocationPatchRequest,
): Promise<{ externalRef: string; readbackValue: string }> {
  const mask = LOCATION_FIELD[request.field];
  if (!mask) {
    throw new PlacementTransportError(`No adapter writes the ${request.field} field.`, false);
  }
  if (!ACCOUNT_REF.test(request.accountRef)) {
    throw new PlacementTransportError(
      "That location reference is not in Google's accounts/{a}/locations/{l} form.",
      false,
    );
  }
  if (typeof request.assertPrewrite !== "function"
    || !(typeof request.currentValue === "string" || request.currentValue === null)) {
    throw new PlacementTransportError("Exact before value and prewrite attestation are required.", false);
  }

  let body: Record<string, unknown>;
  try {
    body = locationPatchBody(request.field, request.value);
  } catch (thrown) {
    if (thrown instanceof PlacementTransportError) throw thrown;
    throw new PlacementTransportError(
      `The approved value for ${request.field} is not in the shape Google accepts: ${
        thrown instanceof Error ? thrown.message : String(thrown)
      }`,
      false,
    );
  }

  const fetchImpl = request.fetchImpl ?? fetch;
  const locationName = `locations/${request.accountRef.split("/")[3]!}`;
  const endpoint = `${LOCATION_API_BASE}/${locationName}`;
  const accountRef = request.accountRef.split("/locations/")[0]!;
  let accountResponse: Response;
  try {
    accountResponse = await fetchImpl(`${ACCOUNT_API_BASE}/${accountRef}`, {
      method: "GET", headers: { Authorization: `Bearer ${request.accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (thrown) {
    throw new PlacementTransportError(
      `Google account preflight failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
      true,
    );
  }
  if (!accountResponse.ok) {
    throw new PlacementTransportError(`Google account preflight refused (${accountResponse.status}).`,
      accountResponse.status === 429 || accountResponse.status >= 500);
  }
  const providerAccount = await accountResponse.json().catch(() => null) as Record<string, unknown> | null;
  if (providerAccount?.name !== accountRef) {
    throw new PlacementTransportError("Google did not confirm the reviewed Business Profile account.", false);
  }
  // A direct locations.get proves the token can see the location, but not
  // that it belongs to the reviewed account. List under that exact account.
  let pageToken: string | null = null;
  let member = false;
  for (let page = 0; page < 100 && !member; page += 1) {
    const params = new URLSearchParams({ readMask: "name", pageSize: "100" });
    if (pageToken) params.set("pageToken", pageToken);
    let membershipResponse: Response;
    try {
      membershipResponse = await fetchImpl(
        `${LOCATION_LIST_API_BASE}/${accountRef}/locations?${params}`,
        { method: "GET", headers: { Authorization: `Bearer ${request.accessToken}` },
          signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
    } catch (thrown) {
      throw new PlacementTransportError(
        `Google location membership preflight failed: ${
          thrown instanceof Error ? thrown.message : String(thrown)}`, true);
    }
    if (!membershipResponse.ok) {
      throw new PlacementTransportError(
        `Google location membership preflight refused (${membershipResponse.status}).`,
        membershipResponse.status === 429 || membershipResponse.status >= 500);
    }
    const listing = await membershipResponse.json().catch(() => null) as Record<string, unknown> | null;
    if (!listing || (listing.locations !== undefined && !Array.isArray(listing.locations))
      || (listing.locations as unknown[] | undefined)?.some((item) => !item || typeof item !== "object"
        || typeof (item as Record<string, unknown>).name !== "string")) {
      throw new PlacementTransportError("Google returned an unreadable account location listing.", false);
    }
    member = ((listing.locations ?? []) as Record<string, unknown>[])
      .some((item) => item.name === locationName);
    const next = listing.nextPageToken;
    if (next !== undefined && typeof next !== "string") {
      throw new PlacementTransportError("Google returned an unreadable location page token.", false);
    }
    pageToken = typeof next === "string" && next ? next : null;
    if (!member && !pageToken) break;
    if (!member && page === 99) {
      throw new PlacementTransportError("Google location membership exceeded the preflight page limit.", false);
    }
  }
  if (!member) {
    throw new PlacementTransportError("The reviewed location is absent from the reviewed Business Profile account.", false);
  }
  async function readLocation(afterWrite: boolean): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchImpl(`${endpoint}?readMask=${encodeURIComponent(mask!)}`, {
        method: "GET", headers: { Authorization: `Bearer ${request.accessToken}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (thrown) {
      throw new PlacementTransportError(
        `${afterWrite ? "Google readback" : "Google preflight"} failed: ${
          thrown instanceof Error ? thrown.message : String(thrown)}`,
        !afterWrite,
      );
    }
    if (!response.ok) {
      throw new PlacementTransportError(
        `Google ${afterWrite ? "readback" : "preflight"} refused (${response.status}).`,
        !afterWrite && (response.status === 429 || response.status >= 500),
      );
    }
    const location = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!location || location.name !== locationName) {
      throw new PlacementTransportError("Google did not confirm the exact location name.", false);
    }
    return location;
  }
  const before = await readLocation(false);
  if (locationFieldValue(before, request.field)
    !== expectedFieldValue(request.field, request.currentValue)) {
    throw new PlacementTransportError("The live Google field differs from the reviewed before value.", false);
  }
  if (request.field === "primary_phone") {
    const phones = before.phoneNumbers;
    if (phones !== undefined && (phones === null || typeof phones !== "object"
      || Array.isArray(phones))) {
      throw new PlacementTransportError("Google returned unreadable phone numbers.", false);
    }
    body = { phoneNumbers: { ...(phones as Record<string, unknown> | undefined),
      primaryPhone: request.value } };
  }
  await request.assertPrewrite();
  let response: Response;
  try {
    response = await fetchImpl(
      `${endpoint}?updateMask=${encodeURIComponent(mask)}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${request.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: locationName, ...body }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
  } catch (thrown) {
    const reason = thrown instanceof Error ? thrown.message : String(thrown);
    throw new PlacementTransportError(
      `Google profile write outcome is uncertain: ${reason} Reconcile before retrying.`, false);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // Narrow, for the same reason the local post is: a 4xx Google chose is
    // permanent until a person changes something.
    throw new PlacementTransportError(
      `Google refused the change (${response.status}): ${(text || "no body").slice(0, 300)}`,
      false,
    );
  }
  const after = await readLocation(true);
  const readbackValue = locationFieldValue(after, request.field);
  if (readbackValue !== expectedFieldValue(request.field, request.value)) {
    throw new PlacementTransportError("Google readback differs from the approved profile value.", false);
  }
  return { externalRef: `${locationName}#${request.field}`,
    readbackValue: readbackValue ?? "" };
}
