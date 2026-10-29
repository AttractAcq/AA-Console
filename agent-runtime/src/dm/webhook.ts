/**
 * The Meta messaging webhook — G01.
 *
 * The only unauthenticated doorway in this system that a third party pushes
 * through, so it is written to be suspicious.
 *
 * THE SIGNATURE IS OVER THE RAW BYTES
 *
 * Meta signs the request body with the app secret and sends
 * `X-Hub-Signature-256: sha256=<hex>`. The HMAC has to be computed over the
 * exact bytes received, which is why this reads the body itself rather than
 * using readJsonBody: parsing and re-serialising changes whitespace and key
 * order, and the signature would never match. Getting this wrong in the
 * other direction -- skipping the check -- would let anybody on the internet
 * invent conversations and leads for any client.
 *
 * The comparison is constant-time. A fast string compare leaks, one byte at
 * a time, how much of a forged signature was right.
 *
 * ALWAYS 200, ALMOST ALWAYS
 *
 * Meta retries anything that is not a 2xx, for hours. So an event for a page
 * we do not recognise, a shape we do not handle, or a message we have
 * already stored is answered 200 and dropped: those are not failures and a
 * retry would not fix them. A bad signature is a 401 and a missing secret is
 * a 503, because those two are worth being loud about.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../config.js";
import { logger } from "../logging/logger.js";

const PATH = "/public/webhooks/meta";
/** Meta's own cap is smaller; this is a guard against a hostile body. */
const MAX_BYTES = 256 * 1024;

export function isMetaWebhookRequest(url: string | undefined): boolean {
  return typeof url === "string" && url.split("?")[0] === PATH;
}

/** The exact bytes, because the signature is over them. */
export function readRawBody(req: IncomingMessage, maxBytes = MAX_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        cleanup();
        reject(new Error("too_large"));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = () => {
      cleanup();
      reject(new Error("read_failed"));
    };
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/** Constant-time comparison of `sha256=<hex>` against the body's HMAC. */
export function signatureMatches(
  header: string | undefined,
  body: Buffer,
  appSecret: string,
): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const given = header.slice("sha256=".length).trim();
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = createHmac("sha256", appSecret).update(body).digest("hex");
  // Both are 64 hex characters by the check above, so the lengths match and
  // timingSafeEqual cannot throw.
  return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}

export interface InboundDm {
  recipientId: string;
  senderId: string;
  platform: "instagram" | "facebook";
  messageId: string | null;
  text: string | null;
  occurredAt: string | null;
}

/**
 * Pulls the messages out of a webhook payload.
 *
 * Deliberately tolerant: Meta sends read receipts, delivery confirmations,
 * reactions and echoes of our own replies through the same endpoint, and the
 * shape differs between Instagram and Messenger. Anything without a sender
 * and a recipient is skipped rather than treated as malformed.
 */
export function inboundMessages(payload: unknown): InboundDm[] {
  const out: InboundDm[] = [];
  const root = payload as { object?: unknown; entry?: unknown } | null;
  if (!root || !Array.isArray(root.entry)) return out;

  const platform = root.object === "instagram" ? "instagram" : "facebook";

  for (const entry of root.entry) {
    const events = (entry as { messaging?: unknown })?.messaging;
    if (!Array.isArray(events)) continue;
    for (const event of events) {
      const e = event as {
        sender?: { id?: unknown };
        recipient?: { id?: unknown };
        timestamp?: unknown;
        message?: { mid?: unknown; text?: unknown; is_echo?: unknown };
      };
      // An echo is our own reply coming back. Storing it would double every
      // outbound message in the thread.
      if (!e.message || e.message.is_echo === true) continue;
      const senderId = e.sender?.id == null ? "" : String(e.sender.id);
      const recipientId = e.recipient?.id == null ? "" : String(e.recipient.id);
      if (!senderId || !recipientId) continue;

      const stamp = Number(e.timestamp);
      out.push({
        recipientId,
        senderId,
        platform,
        messageId: e.message.mid == null ? null : String(e.message.mid),
        text: e.message.text == null ? null : String(e.message.text).slice(0, 8000),
        occurredAt: Number.isFinite(stamp) ? new Date(stamp).toISOString() : null,
      });
    }
  }
  return out;
}

export async function handleMetaWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  sb: SupabaseClient,
  config: RuntimeConfig,
): Promise<void> {
  const send = (status: number, body = "") => {
    res.writeHead(status, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end(body);
  };

  // The subscription handshake. Meta calls this once when the webhook is
  // registered and expects the challenge echoed back verbatim.
  if (req.method === "GET") {
    const url = new URL(req.url ?? PATH, "http://localhost");
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge") ?? "";
    if (!config.metaWebhookVerifyToken) {
      send(503, "not configured");
      return;
    }
    if (mode === "subscribe" && token === config.metaWebhookVerifyToken) {
      send(200, challenge);
      return;
    }
    send(403, "forbidden");
    return;
  }

  if (req.method !== "POST") {
    send(405, "POST only");
    return;
  }

  if (!config.metaAppSecret) {
    // Loud: an unverifiable webhook must never be processed, and silently
    // dropping events would look like Meta not sending them.
    logger.error("meta_webhook_unconfigured", {});
    send(503, "not configured");
    return;
  }

  let raw: Buffer;
  try {
    raw = await readRawBody(req);
  } catch {
    send(400, "bad body");
    return;
  }

  if (!signatureMatches(req.headers["x-hub-signature-256"] as string | undefined, raw, config.metaAppSecret)) {
    logger.warn("meta_webhook_bad_signature", { bytes: raw.length });
    send(401, "bad signature");
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    // Signed but unparseable. Not worth a retry.
    send(200, "ok");
    return;
  }

  const messages = inboundMessages(payload);
  let stored = 0;
  let unknown = 0;

  for (const message of messages) {
    const { data: clientId, error: lookupError } = await sb.rpc("client_for_meta_recipient_v6", {
      p_recipient_id: message.recipientId,
    } as never);
    if (lookupError) {
      logger.warn("meta_webhook_lookup_failed", { error: lookupError.message });
      continue;
    }
    if (typeof clientId !== "string" || !clientId) {
      // Expected: Meta sends events for pages a client has disconnected.
      unknown += 1;
      continue;
    }

    const { error } = await sb.rpc("record_inbound_dm_v6", {
      p_client_id: clientId,
      p_platform: message.platform,
      p_external_user_id: message.senderId,
      p_external_message_id: message.messageId,
      p_body: message.text,
      p_display_name: null,
      p_occurred_at: message.occurredAt,
    } as never);
    if (error) {
      logger.warn("meta_webhook_store_failed", { error: error.message });
      continue;
    }
    stored += 1;
  }

  if (messages.length > 0) {
    logger.info("meta_webhook_received", {
      messages: messages.length, stored, unknownRecipients: unknown,
    });
  }
  // Always 200 once the signature is good. Meta retries non-2xx for hours,
  // and nothing above is fixed by being sent again.
  send(200, "ok");
}
