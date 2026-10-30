/**
 * The public booking surface — G04.
 *
 * Two endpoints behind one token:
 *
 *   GET  /public/book/v1/<token>/slots   what is free
 *   POST /public/book/v1/<token>         take one
 *
 * The token is in the path rather than a header so a link can be put in an
 * email or a DM and simply work, the same choice the sales widget made.
 *
 * NOTHING HERE DECIDES ANYTHING
 *
 * Availability, the notice period, the daily maximum, the buffer, the
 * find-or-create of the lead and the lock that stops two people taking one
 * slot all live in `book_from_public_link_v6`. This route reads a body,
 * calls it, and passes its sentence back. A route that checked availability
 * and then booked would have a gap between the two, and that gap is the
 * double booking.
 *
 * ONE REFUSAL SENTENCE
 *
 * A dead link answers "This booking link is not accepting bookings." and
 * never says whether it was revoked, disabled or expired. An explanatory
 * refusal on an unauthenticated endpoint is a probing tool.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";

import { readJsonBody } from "../mcp/http.js";
import { logger } from "../logging/logger.js";
import { admitPublicRequest } from "../public/quota.js";

const PREFIX = "/public/book/v1/";
/** 64 hex characters, like every other public token in this system. */
const TOKEN = /^[0-9a-f]{64}$/;

export function isBookingRequest(url: string | undefined): boolean {
  return typeof url === "string" && url.startsWith(PREFIX);
}

/** `/public/book/v1/<token>` or `/public/book/v1/<token>/slots`. */
function route(url: string): { token: string; wantsSlots: boolean } | null {
  const path = url.slice(PREFIX.length).split("?")[0] ?? "";
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0 || parts.length > 2) return null;
  const token = parts[0]!;
  if (!TOKEN.test(token)) return null;
  if (parts.length === 2 && parts[1] !== "slots") return null;
  return { token, wantsSlots: parts.length === 2 };
}

export async function handlePublicBooking(
  req: IncomingMessage,
  res: ServerResponse,
  sb: SupabaseClient,
  config: RuntimeConfig,
): Promise<void> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      // A booking page lives on the client's own site, which is not one of
      // our origins.
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    res.end(JSON.stringify(body));
  };

  if (req.method === "OPTIONS") {
    json(204, {});
    return;
  }

  const parsed = route(req.url ?? "");
  if (!parsed) {
    json(404, { error: "This booking link is not accepting bookings." });
    return;
  }

  if (parsed.wantsSlots) {
    if (req.method !== "GET") {
      json(405, { error: "GET only" });
      return;
    }
    const { data, error } = await sb.rpc("public_slots_for_link_v6", {
      p_token: parsed.token,
      p_days: 14,
    } as never);
    if (error) {
      logger.warn("booking_slots_failed", { error: error.message });
      json(503, { error: "Could not read the available times." });
      return;
    }
    // An empty list is the answer for a dead link too, so this endpoint
    // cannot be used to tell a real token from a wrong one.
    json(200, { slots: (data ?? []) as unknown[] });
    return;
  }

  if (req.method !== "POST") {
    json(405, { error: "POST only" });
    return;
  }

  const admitted = await admitPublicRequest(req, sb, config, "booking_submit", parsed.token);
  if (!admitted.allowed) {
    json(admitted.reason === "quota" ? 429 : 503, {
      error: admitted.reason === "quota" ? "Please try again shortly." : "Could not accept the booking right now.",
    });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req, 8192);
  } catch {
    json(400, { error: "Expected a JSON body." });
    return;
  }

  const startsAt = String(body.startsAt ?? "");
  if (!startsAt || Number.isNaN(Date.parse(startsAt))) {
    json(400, { error: "Choose one of the available times." });
    return;
  }

  const { data, error } = await sb.rpc("book_from_public_link_v6", {
    p_token: parsed.token,
    p_name: body.name == null ? null : String(body.name).slice(0, 200),
    p_email: body.email == null ? null : String(body.email).slice(0, 320),
    p_phone: body.phone == null ? null : String(body.phone).slice(0, 40),
    p_starts_at: startsAt,
    p_consent_wording: body.consent == null ? null : String(body.consent).slice(0, 2000),
  } as never);

  if (error) {
    // The database's own sentence, written to be read by the person who
    // pressed the button: "That slot is not available", "An email address or
    // a phone number is needed to hold the slot".
    logger.info("booking_refused", { reason: error.message });
    json(400, { error: error.message });
    return;
  }

  const booked = (Array.isArray(data) ? data[0] : data) as
    { appointment_id?: string; starts_at?: string } | null;
  if (!booked?.appointment_id) {
    json(503, { error: "The booking was not recorded. Nothing has been held." });
    return;
  }

  logger.info("booking_taken", { appointmentId: booked.appointment_id });
  json(201, { booked: true, startsAt: booked.starts_at ?? startsAt });
}
