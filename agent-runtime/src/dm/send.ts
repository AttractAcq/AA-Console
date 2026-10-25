/**
 * Replying through Meta's Send API — G01.
 *
 * The transport behind the `instagram_dm` and `messenger` channels. Which
 * thread, whether the window is open, whether the person is suppressed and
 * whether the words were approved are all decided in the database before
 * anything reaches here.
 *
 * WHAT A FAILURE MEANS HERE
 *
 * Narrow retryability, like the Business Profile poster: a message cannot be
 * unsent, and most of Meta's refusals are permanent until somebody changes
 * something. The one that matters is code 10, subcode 2018278 — outside the
 * allowed window. That is never retryable, however many times it is tried,
 * because only another message from the person reopens it; retrying it would
 * burn five attempts to learn what the first one said.
 *
 * NOT PROVEN AGAINST A REAL ACCOUNT
 *
 * Meta grants messaging permissions by app review, and no client here has
 * them yet. The call is the real Send API endpoint and the acceptance gate
 * is a reply appearing in a real thread with its message id recorded, not
 * this file existing. `message_channels` says the same thing.
 */

const GRAPH_VERSION = "v21.0";
const BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const TIMEOUT_MS = 20_000;

export class DmSendError extends Error {
  constructor(message: string, readonly retryable: boolean = false) {
    super(message);
    this.name = "DmSendError";
  }
}

export interface DmSendRequest {
  /** Read from the Vault by the caller. This file never touches the database. */
  readonly accessToken: string;
  /** The page or Instagram account the reply is sent from. */
  readonly senderId: string;
  /** The person's scoped id, which is the address on a DM channel. */
  readonly recipientId: string;
  readonly text: string;
  readonly fetchImpl?: typeof fetch;
}

/** Meta's error shape, far enough in to find the subcode. */
interface MetaError {
  error?: { message?: unknown; code?: unknown; error_subcode?: unknown; type?: unknown };
}

/** Outside the 24-hour window. Permanent until the person writes again. */
export const OUTSIDE_WINDOW_SUBCODE = 2018278;

export function classifyDmFailure(status: number, body: unknown): DmSendError {
  const parsed = (body ?? {}) as MetaError;
  const message = String(parsed.error?.message ?? "no message");
  const subcode = Number(parsed.error?.error_subcode ?? 0);

  if (subcode === OUTSIDE_WINDOW_SUBCODE) {
    return new DmSendError(
      `Meta refused the reply: the messaging window has closed. Only another message from them reopens it. (${message})`,
      false,
    );
  }
  // A rate limit or a server fault certainly happened before any delivery.
  if (status === 429 || status >= 500) {
    return new DmSendError(`Meta could not take the reply (${status}): ${message}`, true);
  }
  return new DmSendError(`Meta refused the reply (${status}): ${message}`, false);
}

export async function sendDm(request: DmSendRequest): Promise<string> {
  if (!request.accessToken) {
    throw new DmSendError("No Meta credential for this client.", false);
  }
  if (!request.text.trim()) {
    throw new DmSendError("A reply with no words is not a reply.", false);
  }

  const fetchImpl = request.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${BASE}/${encodeURIComponent(request.senderId)}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${request.accessToken}`,
      },
      body: JSON.stringify({
        recipient: { id: request.recipientId },
        message: { text: request.text },
        // The only tag-free type. A business reply inside the window needs no
        // tag, and sending one would claim an exemption we do not have.
        messaging_type: "RESPONSE",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (thrown) {
    const reason = thrown instanceof Error ? thrown.message : String(thrown);
    throw new DmSendError(`Could not reach the Send API: ${reason}`, true);
  }

  const text = await response.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  if (!response.ok) throw classifyDmFailure(response.status, parsed);

  const id = (parsed as { message_id?: unknown } | null)?.message_id;
  if (typeof id !== "string" || !id) {
    // Accepted with nothing to record. It may be in the thread with no
    // reference to trace, which is worse than a failure, so it does not retry.
    throw new DmSendError(
      "Meta accepted the reply but returned no message id, so there is nothing to trace. Check the thread before resending.",
      false,
    );
  }
  return id;
}
