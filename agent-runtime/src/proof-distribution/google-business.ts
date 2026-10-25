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
/** Long enough for a slow API, short enough that a sweep's lease outlives it. */
const TIMEOUT_MS = 30_000;

export class PlacementTransportError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean = false,
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
  } catch (thrown) {
    // No response at all. The request may or may not have reached Google,
    // and an aborted call is the one case where trying again is the lesser
    // risk: a local post is created with a server-assigned name, so a
    // duplicate is visible on the profile rather than silently merged.
    const reason = thrown instanceof Error ? thrown.message : String(thrown);
    throw new PlacementTransportError(`Could not reach the Business Profile API: ${reason}`, true);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    const detail = (text || "no body").slice(0, 500);
    // 408 and 429 are the API saying "not now"; 5xx is it failing on its own
    // side. Everything else is a decision it made.
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new PlacementTransportError(
      `Google Business Profile refused the post (${response.status}): ${detail}`,
      retryable,
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
      false,
    );
  }
  return { externalId: name, externalUrl: parsed?.searchUrl?.trim() || null };
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
  primary_phone: "phoneNumbers.primaryPhone",
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
  readonly fetchImpl?: typeof fetch;
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
): Promise<{ externalRef: string }> {
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
  let response: Response;
  try {
    response = await fetchImpl(
      `${API_BASE}/${request.accountRef}?updateMask=${encodeURIComponent(mask)}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${request.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
  } catch (thrown) {
    const reason = thrown instanceof Error ? thrown.message : String(thrown);
    throw new PlacementTransportError(`Could not reach the Business Profile API: ${reason}`, true);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // Narrow, for the same reason the local post is: a 4xx Google chose is
    // permanent until a person changes something.
    const retryable = response.status === 429 || response.status >= 500;
    throw new PlacementTransportError(
      `Google refused the change (${response.status}): ${(text || "no body").slice(0, 300)}`,
      retryable,
    );
  }
  return { externalRef: `${request.accountRef}#${request.field}` };
}
