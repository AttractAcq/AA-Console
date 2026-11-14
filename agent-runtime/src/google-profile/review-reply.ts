import { createHash } from "node:crypto";

const API_ROOT = "https://mybusiness.googleapis.com/v4";
const ACCOUNT_API_ROOT = "https://mybusinessaccountmanagement.googleapis.com/v1";
const LOCATION_REF = /^accounts\/[A-Za-z0-9_-]+\/locations\/[A-Za-z0-9_-]+$/;
const REVIEW_ID = /^[A-Za-z0-9_-]+$/;
const MAX_REPLY_BYTES = 4096;
const TIMEOUT_MS = 30_000;

export class GoogleReplyTransportError extends Error {
  constructor(message: string, readonly outcomeUncertain = false) {
    super(message);
    this.name = "GoogleReplyTransportError";
  }
}

export interface ReviewReplyRequest {
  accessToken: string;
  locationRef: string;
  reviewRef: string;
  exactBody: string;
  /** Must attest the current exact Inbox decision and claimed attempt. */
  assertPrewrite: () => Promise<void>;
  fetchImpl?: typeof fetch;
}

export interface ReviewReplyReceipt {
  reviewRef: string;
  bodySha256: string;
  providerUpdateTime: string | null;
  providerState: string | null;
  alreadyPresent: boolean;
}

interface ProviderReview {
  name?: unknown;
  reviewReply?: { comment?: unknown; updateTime?: unknown; reviewReplyState?: unknown };
}

function resourceName(locationRef: string, reviewRef: string): string {
  if (!LOCATION_REF.test(locationRef)) {
    throw new GoogleReplyTransportError("A verified Google Business Profile location is required.");
  }
  const full = `${locationRef}/reviews/${reviewRef}`;
  if (REVIEW_ID.test(reviewRef)) return full;
  if (reviewRef.startsWith(`${locationRef}/reviews/`)
    && REVIEW_ID.test(reviewRef.slice(`${locationRef}/reviews/`.length))) return reviewRef;
  throw new GoogleReplyTransportError("The review ID does not belong to the selected location.");
}

async function requestJson(
  fetchImpl: typeof fetch, url: string, accessToken: string,
  method: "GET" | "PUT", body?: string, resource = "review",
): Promise<ProviderReview> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method, signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(method === "PUT" ? { "Content-Type": "application/json" } : {}),
      },
      ...(method === "PUT" ? { body: JSON.stringify({ comment: body }) } : {}),
    });
  } catch {
    throw new GoogleReplyTransportError(
      `Google ${resource} ${method === "PUT" ? "write" : "read"} did not return an outcome. Reconcile the provider state before another attempt.`,
      method === "PUT",
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new GoogleReplyTransportError(
      `Google ${resource} ${method === "PUT" ? "write" : "read"} returned HTTP ${response.status}.`,
      method === "PUT" && response.status >= 500,
    );
  }
  try {
    return await response.json() as ProviderReview;
  } catch {
    throw new GoogleReplyTransportError("Google returned an unreadable review response.", method === "PUT");
  }
}

/** PUT is preceded by an exact approval check and followed by a GET readback. */
export async function putApprovedReviewReply(request: ReviewReplyRequest): Promise<ReviewReplyReceipt> {
  const name = resourceName(request.locationRef, request.reviewRef);
  if (!request.accessToken) throw new GoogleReplyTransportError("No Google Business credential is available.");
  if (!request.exactBody.trim() || Buffer.byteLength(request.exactBody, "utf8") > MAX_REPLY_BYTES) {
    throw new GoogleReplyTransportError("The exact approved reply must contain 1–4096 UTF-8 bytes.");
  }
  const fetchImpl = request.fetchImpl ?? fetch;
  const url = `${API_ROOT}/${name}`;
  const accountRef = request.locationRef.split("/locations/")[0];
  const account = await requestJson(fetchImpl, `${ACCOUNT_API_ROOT}/${accountRef}`,
    request.accessToken, "GET", undefined, "account");
  if (account.name !== accountRef) {
    throw new GoogleReplyTransportError("Google did not confirm access to the approved Business Profile account.");
  }
  const before = await requestJson(fetchImpl, url, request.accessToken, "GET");
  if (before.name !== name) {
    throw new GoogleReplyTransportError("Google returned a different review than the approved destination.");
  }
  const existing = before.reviewReply?.comment;
  if (typeof existing === "string" && existing !== request.exactBody) {
    throw new GoogleReplyTransportError("The review already has different reply words; a new human decision is required.");
  }
  // One last read of the canonical decision after the provider preflight and
  // immediately before the write (or an idempotent reconciliation result).
  await request.assertPrewrite();
  const alreadyPresent = existing === request.exactBody;
  if (!alreadyPresent) {
    await requestJson(fetchImpl, `${url}/reply`, request.accessToken, "PUT", request.exactBody);
  }
  const after = await requestJson(fetchImpl, url, request.accessToken, "GET").catch(() => {
    throw new GoogleReplyTransportError("Google accepted the reply but readback is unknown. Reconcile before retrying.", true);
  });
  if (after.name !== name || after.reviewReply?.comment !== request.exactBody) {
    throw new GoogleReplyTransportError("Google readback does not match the approved reply. Reconcile before retrying.", true);
  }
  return {
    reviewRef: name,
    bodySha256: createHash("sha256").update(request.exactBody, "utf8").digest("hex"),
    providerUpdateTime: typeof after.reviewReply.updateTime === "string" ? after.reviewReply.updateTime : null,
    providerState: typeof after.reviewReply.reviewReplyState === "string"
      ? after.reviewReply.reviewReplyState : null,
    alreadyPresent,
  };
}
