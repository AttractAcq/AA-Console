/**
 * The courier.
 *
 * Somebody handed over their email address because they were promised a
 * file. This is the thing that keeps that promise, and the only part of the
 * system whose failure a stranger notices directly.
 *
 * TWO CHECKS BEFORE EVERY SEND, NOT ONE
 *
 * `lead_magnet_due` has already confirmed the approval is live, matches the
 * file's hash and that the client is switched on — inside the same locked
 * statement that claimed the row, so it cannot go stale between the question
 * and the claim. What that cannot check is the file itself: the hash in the
 * database is a record of what was uploaded, not proof that the object in
 * storage still matches it. So this downloads the file and hashes the bytes
 * before attaching them, and refuses when they differ.
 *
 * That check is the whole point of the module. Without it "the exact file
 * somebody approved" means "a path somebody approved", and a path can be
 * overwritten.
 *
 * RETRYABLE IS NARROW
 *
 * A provider accepting a message is not a person receiving it, and sending
 * the same file twice is a small annoyance while sending the wrong file once
 * is not. Only faults that certainly happened before the provider took the
 * message are retried: a missing configuration, a network error, a 429 or a
 * 5xx. A rejected address is permanent until somebody changes something.
 */

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../config.js";
import type { AgentRow } from "../orchestration/registry.js";
import type { JobResult } from "../orchestration/dispatch.js";
import type { AgentJobRow } from "../queue.js";
import { appendEvent } from "../queue.js";
import { logger } from "../logging/logger.js";

const MAGNET_BUCKET = "client-media";
const DEFAULT_BATCH = 5;
/** Long enough for a large PDF, short enough that the lease outlives it. */
const SEND_TIMEOUT_MS = 30_000;

export class CourierError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "CourierError";
  }
}

export interface ClaimedDelivery {
  delivery_id: string;
  client_id: string;
  magnet_version_id: string;
  channel: string;
  recipient: string;
  storage_path: string;
  media_type: string;
  content_sha256: string;
  delivery_subject: string | null;
  delivery_body: string | null;
  magnet_name: string;
  attempt: number;
}

/**
 * The file, with its bytes checked against the hash that was approved.
 *
 * Downloaded rather than linked because the promise was a file, and a signed
 * URL that expires before somebody opens their email is a broken promise
 * wearing a success state.
 */
export async function fetchApprovedFile(
  sb: SupabaseClient,
  delivery: ClaimedDelivery,
): Promise<Buffer> {
  const { data, error } = await sb.storage.from(MAGNET_BUCKET).download(delivery.storage_path);
  if (error || !data) {
    throw new CourierError(
      `Could not read ${delivery.storage_path}: ${error?.message ?? "no file"}`,
      true,
    );
  }
  const bytes = Buffer.from(await data.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== delivery.content_sha256) {
    // The object was replaced after approval. Non-retryable: trying again
    // sends the same wrong file.
    throw new CourierError(
      `The file at ${delivery.storage_path} no longer matches what was approved. Nothing was sent.`,
      false,
    );
  }
  return bytes;
}

/** One email, with the approved words and the approved file attached. */
export async function sendByEmail(
  config: RuntimeConfig,
  delivery: ClaimedDelivery,
  file: Buffer,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!config.resendApiKey) {
    throw new CourierError("Email provider is not configured (RESEND_API_KEY).", true);
  }
  const filename = delivery.storage_path.split("/").pop() ?? "download";

  let response: Response;
  try {
    response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.resendApiKey}`,
        "Content-Type": "application/json",
        // The provider's own guard against a double send, keyed on the
        // delivery rather than the attempt: a retry after an ambiguous
        // failure is the same message, not a new one.
        "Idempotency-Key": `lead-magnet-${delivery.delivery_id}`,
      },
      body: JSON.stringify({
        from: config.resendFrom,
        to: [delivery.recipient],
        subject: delivery.delivery_subject ?? delivery.magnet_name,
        text: delivery.delivery_body ?? `Here is the ${delivery.magnet_name}, as promised.`,
        attachments: [{ filename, content: file.toString("base64") }],
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (thrown) {
    // No response at all. The message may or may not have been accepted, but
    // the idempotency key above means a retry cannot duplicate it.
    const reason = thrown instanceof Error ? thrown.message : String(thrown);
    throw new CourierError(`Could not reach the email provider: ${reason}`, true);
  }

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw new CourierError(
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
    // way with no reference to trace. Non-retryable, and the message says so.
    throw new CourierError(
      "The provider accepted it but returned no reference, so there is nothing to trace. Check the provider before resending.",
      false,
    );
  }
  return id;
}

export async function runLeadMagnetCourierJob(
  sb: SupabaseClient,
  runtime: RuntimeConfig,
  agent: AgentRow,
  job: AgentJobRow,
): Promise<JobResult> {
  if (!runtime.leadMagnetDeliveryEnabled) {
    await appendEvent(
      sb,
      job.id,
      "Lead magnet delivery is off in this runtime (LEAD_MAGNET_DELIVERY_ENABLED). Nothing was claimed.",
      "info",
    );
    return { ok: true, retryable: false };
  }

  const asked = Number((job.params as Record<string, unknown> | null)?.limit ?? DEFAULT_BATCH);
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.trunc(asked), 25) : DEFAULT_BATCH;
  const { data, error } = await sb.rpc("claim_lead_magnet_deliveries", { p_limit: limit } as never);
  if (error) throw new Error(`Could not claim deliveries: ${error.message}`);

  const claimed = (data ?? []) as ClaimedDelivery[];
  if (claimed.length === 0) {
    await appendEvent(sb, job.id, "Nobody is waiting for a magnet.", "info");
    return { ok: true, retryable: false };
  }

  let sent = 0;
  let failed = 0;

  for (const delivery of claimed) {
    try {
      if (delivery.channel !== "email") {
        // A download link is handed back by the page at opt-in time; there is
        // nothing for a courier to carry.
        throw new CourierError(
          `There is no courier for the ${delivery.channel} channel.`,
          false,
        );
      }
      const file = await fetchApprovedFile(sb, delivery);
      const providerRef = await sendByEmail(runtime, delivery, file);

      const { error: recordError } = await sb.rpc("record_lead_magnet_sent", {
        p_delivery_id: delivery.delivery_id,
        p_provider_ref: providerRef,
      } as never);
      // It has gone. A failure to record leaves the row claimed for the
      // reaper, which fails it and says to check the provider — wrong, but
      // visible, and the right instruction.
      if (recordError) throw new Error(`Sent, but could not record it: ${recordError.message}`);

      sent += 1;
      await appendEvent(sb, job.id, `${delivery.magnet_name}: sent.`, "info", {
        delivery_id: delivery.delivery_id,
        provider_ref: providerRef,
      });
      logger.info("lead_magnet_sent", {
        jobId: job.id,
        deliveryId: delivery.delivery_id,
      });
    } catch (thrown) {
      failed += 1;
      const retryable = thrown instanceof CourierError ? thrown.retryable : false;
      const reason = thrown instanceof Error ? thrown.message : String(thrown);
      const { error: failError } = await sb.rpc("record_lead_magnet_failure", {
        p_delivery_id: delivery.delivery_id,
        p_reason: reason,
        p_retryable: retryable,
      } as never);
      if (failError) {
        logger.error("lead_magnet_failure_unrecorded", {
          jobId: job.id,
          deliveryId: delivery.delivery_id,
          message: failError.message,
        });
      }
      await appendEvent(sb, job.id, `${delivery.magnet_name}: ${reason}`, "warn", {
        delivery_id: delivery.delivery_id,
        retryable,
      });
    }
  }

  await appendEvent(sb, job.id, `${sent} sent, ${failed} not.`, failed > 0 ? "warn" : "info", {
    sent,
    failed,
    claimed: claimed.length,
  });

  void agent;
  return { ok: true, retryable: false };
}
