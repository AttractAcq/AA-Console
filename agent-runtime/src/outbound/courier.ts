/**
 * The governed outbound courier — G02.
 *
 * Migration 249 decides what may be sent and to whom; this sends it. The
 * division is deliberate and is the same one the publisher and the proof
 * placer use: every rule lives in `claim_outbound_messages`, inside the same
 * locked statement as the claim, so a worker cannot be the thing that
 * decides whether a person consented.
 *
 * OFF IS A STATE, NOT AN ERROR
 *
 * With OUTBOUND_MESSAGING_ENABLED unset this claims nothing and says so,
 * successfully. A dry run reporting success would have the database record a
 * message that never left, which is a lie told in the one place a person
 * checks before asking why a client's leads went quiet.
 *
 * WHY THE PROVIDER GETS AN IDEMPOTENCY KEY TOO
 *
 * A send that times out may or may not have been accepted. The database's
 * idempotency key stops a second row; the provider's key stops a second
 * email from the same row's retry. Both are needed, because the ambiguous
 * failure is the common one.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../config.js";
import type { AgentRow } from "../orchestration/registry.js";
import type { JobResult } from "../orchestration/dispatch.js";
import type { AgentJobRow } from "../queue.js";
import { appendEvent } from "../queue.js";
import { logger } from "../logging/logger.js";
import { DmSendError, sendDm } from "../dm/send.js";

const DEFAULT_BATCH = 10;
const SEND_TIMEOUT_MS = 20_000;

export class SendError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = "SendError";
    this.retryable = retryable;
  }
}

export interface ClaimedMessage {
  message_id: string;
  client_id: string;
  lead_id: string;
  channel_key: string;
  address: string;
  rendered_subject: string | null;
  rendered_body: string;
  attempts: number;
}

/** One email, with the approved words, to the address resolved at queue time. */
export async function sendEmail(
  config: RuntimeConfig,
  message: ClaimedMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!config.resendApiKey) {
    throw new SendError("Email provider is not configured (RESEND_API_KEY).", true);
  }

  let response: Response;
  try {
    response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.resendApiKey}`,
        "Content-Type": "application/json",
        // Keyed on the message, not the attempt: a retry after an ambiguous
        // failure is the same message rather than a new one.
        "Idempotency-Key": `outbound-${message.message_id}`,
      },
      body: JSON.stringify({
        from: config.resendFrom,
        to: [message.address],
        subject: message.rendered_subject ?? "A message about your enquiry",
        text: message.rendered_body,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (thrown) {
    const reason = thrown instanceof Error ? thrown.message : String(thrown);
    throw new SendError(`Could not reach the email provider: ${reason}`, true);
  }

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw new SendError(
      `The email provider refused it (${response.status}): ${(text || "no body").slice(0, 300)}`,
      retryable,
    );
  }

  let id = "";
  try {
    id = String((JSON.parse(text) as { id?: string }).id ?? "");
  } catch {
    id = "";
  }
  if (!id) {
    // Accepted with nothing to record. Worse than a failure: it may be on its
    // way with no reference to trace, so this does not retry.
    throw new SendError(
      "The provider accepted it but returned no reference, so there is nothing to trace. Check the provider before resending.",
      false,
    );
  }
  return id;
}

/** One sender per channel, and no default: an unsupported channel must fail loudly. */
type Sender = (
  config: RuntimeConfig,
  message: ClaimedMessage,
  fetchImpl?: typeof fetch,
  sb?: SupabaseClient,
) => Promise<string>;

/**
 * A DM reply. The address is the person's scoped id, and the sender is the
 * client's page — read here rather than carried on the message, because a
 * page id can change and the reply should go from whatever is connected now.
 */
export async function sendDirectMessage(
  config: RuntimeConfig,
  message: ClaimedMessage,
  fetchImpl: typeof fetch = fetch,
  sb?: SupabaseClient,
): Promise<string> {
  if (!sb) {
    throw new SendError("A DM reply needs the database to read the page and the token.", false);
  }
  const { data: integration, error } = await sb
    .from("client_integrations")
    .select("meta_page_id")
    .eq("client_id", message.client_id)
    .eq("provider", "meta")
    .maybeSingle();
  if (error) throw new SendError(`Could not read the Meta integration: ${error.message}`, true);
  const senderId = (integration as { meta_page_id?: string } | null)?.meta_page_id;
  if (!senderId) {
    throw new SendError("This client has no connected Meta page to reply from.", false);
  }

  const { data: token, error: tokenError } = await sb.rpc("integration_secret", {
    p_client_id: message.client_id,
    p_provider: "meta",
  } as never);
  if (tokenError) throw new SendError(`Could not read the Meta credential: ${tokenError.message}`, true);
  if (typeof token !== "string" || !token) {
    throw new SendError("This client's Meta credential is missing.", false);
  }

  try {
    return await sendDm({
      accessToken: token,
      senderId,
      recipientId: message.address,
      text: message.rendered_body,
      fetchImpl,
    });
  } catch (thrown) {
    const retryable = thrown instanceof DmSendError ? thrown.retryable : false;
    throw new SendError(thrown instanceof Error ? thrown.message : String(thrown), retryable);
  }
}

export const SENDERS: Readonly<Record<string, Sender>> = {
  email: sendEmail,
  instagram_dm: sendDirectMessage,
  messenger: sendDirectMessage,
};

/**
 * The sweep. Split from the job runner so a test can drive it with a stub
 * fetch: the dispatch map's fifth parameter is a deadline, not a transport,
 * and widening it for one agent's convenience would be the wrong trade.
 */
export async function deliverClaimedMessages(
  sb: SupabaseClient,
  config: RuntimeConfig,
  job: AgentJobRow,
  fetchImpl: typeof fetch = fetch,
): Promise<JobResult> {
  if (!config.outboundMessagingEnabled) {
    await appendEvent(
      sb,
      job.id,
      "Outbound messaging is off in this runtime (OUTBOUND_MESSAGING_ENABLED). Nothing was claimed.",
      "info",
    );
    return { ok: true, retryable: false };
  }

  const { data, error } = await sb.rpc("claim_outbound_messages", {
    p_limit: DEFAULT_BATCH,
  } as never);
  if (error) {
    return { ok: false, retryable: true, failureMessage: `Could not claim messages: ${error.message}` };
  }

  const claimed = (data ?? []) as ClaimedMessage[];
  if (claimed.length === 0) {
    await appendEvent(sb, job.id, "No message was waiting to go out.", "info");
    return { ok: true, retryable: false };
  }

  let sent = 0;
  let failed = 0;

  for (const message of claimed) {
    try {
      const sender = SENDERS[message.channel_key];
      if (!sender) {
        // Only reachable if a channel is marked supported without a sender,
        // which is exactly the mistake worth a loud non-retryable failure.
        throw new SendError(
          `No sender is implemented for ${message.channel_key}, although the channel is marked supported.`,
          false,
        );
      }
      const externalId = await sender(config, message, fetchImpl, sb);

      const { error: recordError } = await sb.rpc("record_outbound_message_sent", {
        p_message_id: message.message_id,
        p_external_id: externalId,
      } as never);
      // It has gone. If this write fails the row stays claimed and the reaper
      // releases it, which would resend — but the provider's idempotency key
      // makes that a no-op rather than a second email.
      if (recordError) {
        throw new SendError(`Sent, but could not record it: ${recordError.message}`, true);
      }

      sent += 1;
      await appendEvent(sb, job.id, `Sent one ${message.channel_key} message.`, "info", {
        message_id: message.message_id,
        external_id: externalId,
      });
      logger.info("outbound_message_sent", {
        jobId: job.id, messageId: message.message_id, channel: message.channel_key,
      });
    } catch (thrown) {
      failed += 1;
      const retryable = thrown instanceof SendError ? thrown.retryable : false;
      const reason = thrown instanceof Error ? thrown.message : String(thrown);
      const { error: failError } = await sb.rpc("record_outbound_message_failure", {
        p_message_id: message.message_id,
        p_reason: reason,
        p_retryable: retryable,
      } as never);
      if (failError) {
        logger.error("outbound_failure_not_recorded", {
          jobId: job.id, messageId: message.message_id, error: failError.message,
        });
      }
      await appendEvent(sb, job.id, `A message failed: ${reason}`, "warn", {
        message_id: message.message_id, retryable,
      });
    }
  }

  await appendEvent(
    sb, job.id,
    `${sent} sent, ${failed} failed, of ${claimed.length} claimed.`,
    failed > 0 ? "warn" : "info",
  );
  return { ok: true, retryable: false };
}


export async function runOutboundCourierJob(
  sb: SupabaseClient,
  config: RuntimeConfig,
  _agent: AgentRow,
  job: AgentJobRow,
): Promise<JobResult> {
  return deliverClaimedMessages(sb, config, job);
}
