/**
 * Marketing API writes.
 *
 * The metrics connector reads insights; nothing until now wrote. This creates
 * campaigns, ad sets and ads in a client's ad account — the only place in the
 * system that can make an object Meta will charge for.
 *
 * Everything is created PAUSED, and there is no code path that sets ACTIVE.
 * Launching is a person in Ads Manager looking at what was built and deciding
 * to spend. That is deliberately an absence rather than a permission check: a
 * permission check can be wrong about who is asking, and this cannot be asked.
 *
 * refusesToSendLive below is the second guard. The payload builders already
 * hard-code PAUSED, so this is checking work that is already correct — which
 * is the point, because it keeps being correct after somebody edits them.
 */

import { PAUSED } from "./payload.js";

const GRAPH_VERSION = "v21.0";
const BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const TIMEOUT_MS = 60_000;

export class MetaWriteError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;
  constructor(message: string, retryable: boolean, status: number | null = null) {
    super(message);
    this.name = "MetaWriteError";
    this.retryable = retryable;
    this.status = status;
  }
}

/**
 * Meta's error codes, mapped to whether trying again could plausibly work.
 *
 * Matches the classifier in metrics_ingest/graph.ts, with one addition that
 * only applies to writes: 1487 and its subcodes are spend and permission
 * limits on the ad account, and retrying one spends nothing but time.
 */
export function classifyWrite(status: number, body: unknown): MetaWriteError {
  const error = (body as { error?: { message?: string; code?: number } })?.error;
  const code = error?.code;
  const message = error?.message ?? `Marketing API returned ${status}`;

  if (code === 190 || code === 200 || code === 10 || code === 272) {
    return new MetaWriteError(
      `${message} (the client's Meta credential needs reconnecting, with ads_management scope)`,
      false,
      status,
    );
  }
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 1 || code === 2) {
    return new MetaWriteError(`${message} (rate limited)`, true, status);
  }
  if (code === 1487) {
    return new MetaWriteError(`${message} (ad account limit)`, false, status);
  }
  if (status === 429 || status >= 500) return new MetaWriteError(message, true, status);
  return new MetaWriteError(message, false, status);
}

/**
 * Refuses any payload that is not paused. `what` carries its own article,
 * because "a ad set" is what a template that guesses one produces.
 *
 * Throws rather than correcting it. A payload arriving here with a different
 * status means something upstream decided to launch, and quietly pausing it
 * would hide that decision instead of stopping it.
 */
export function refusesToSendLive(payload: { status?: unknown }, what: string): void {
  if (payload.status !== PAUSED) {
    throw new MetaWriteError(
      `Refusing to create ${what} with status ${String(payload.status)}. ` +
        `This system only creates paused objects; launching is done in Ads Manager.`,
      false,
    );
  }
}

export interface AdAccount {
  accessToken: string;
  /** act_<id>. */
  accountId: string;
}

async function post(
  account: AdAccount,
  edge: string,
  payload: Record<string, unknown>,
): Promise<{ id: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE}/${encodeURIComponent(account.accountId)}/${edge}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${account.accessToken}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) throw classifyWrite(response.status, body);
    const id = body?.id;
    if (typeof id !== "string" || !id) {
      throw new MetaWriteError(`Meta accepted the ${edge} write but returned no id.`, false);
    }
    return { id };
  } catch (error) {
    if (error instanceof MetaWriteError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new MetaWriteError(`Could not reach the Marketing API: ${message}`, true);
  } finally {
    clearTimeout(timer);
  }
}

export async function createCampaign(
  account: AdAccount,
  payload: Record<string, unknown>,
): Promise<{ id: string }> {
  refusesToSendLive(payload, "a campaign");
  return post(account, "campaigns", payload);
}

export async function createAdSet(
  account: AdAccount,
  payload: Record<string, unknown>,
): Promise<{ id: string }> {
  refusesToSendLive(payload, "an ad set");
  return post(account, "adsets", payload);
}

export async function createAd(
  account: AdAccount,
  payload: Record<string, unknown>,
): Promise<{ id: string }> {
  refusesToSendLive(payload, "an ad");
  return post(account, "ads", payload);
}
