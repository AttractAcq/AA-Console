/**
 * The first way into this system for somebody who is not signed in.
 *
 * `POST /public/lead/submit` with a capture token. That is the whole surface.
 * Everything that decides whether a submission may become a lead lives in
 * `capture_lead_v6`, not here: the endpoint's state, its expiry, its quota,
 * consent, contactability, deduplication. This route's job is to be a thin,
 * rude doorway — hash the token, rate limit the caller, pass on what they
 * sent, and never explain itself.
 *
 * WHAT IT DELIBERATELY DOES NOT TELL ANYBODY
 *
 * A wrong token, a disabled endpoint, an expired one and an exhausted one all
 * return the same sentence. A public caller must not be able to probe for
 * live endpoints, or learn which client an endpoint belongs to, or discover
 * that an address is already on file. "Thanks, that is with us" is the only
 * success message, whether a lead was created or merged into one that existed.
 *
 * WHAT IT RECORDS ABOUT THE CALLER
 *
 * A hash of the ip and a hash of the user agent, salted with the runtime's
 * own salt. Never the raw values: they are personal data, and a hash answers
 * the only question anybody actually asks of them, which is whether two
 * submissions came from the same place.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../config.js";
import { readJsonBody } from "../mcp/http.js";
import { logger } from "../logging/logger.js";

/** Same construction as the proof portal's, so one salt covers both. */
export const hashCaptureToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const saltedHash = (value: string, salt: string) =>
  createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 32);

/** Per-token attempt counter, in memory. Enough to blunt a script. */
const attempts = new Map<string, { count: number; until: number }>();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;
const MAX_TRACKED = 5000;

/** The one thing every refusal says. */
const REFUSAL = "This form is not accepting submissions.";

function callerIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (first?.split(",")[0] ?? req.socket.remoteAddress ?? "unknown").trim();
}

export async function handlePublicLead(
  req: IncomingMessage,
  res: ServerResponse,
  sb: SupabaseClient,
  config: RuntimeConfig,
): Promise<void> {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(body));
  };

  if (req.method !== "POST" || req.url !== "/public/lead/submit") {
    json(404, { error: "Not found" });
    return;
  }

  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (!/^[a-f0-9]{64}$/.test(token)) {
    json(404, { error: REFUSAL });
    return;
  }
  const hash = hashCaptureToken(token);

  const now = Date.now();
  if (attempts.size > MAX_TRACKED) {
    for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
  }
  if (attempts.size >= MAX_TRACKED && !attempts.has(hash)) {
    json(429, { error: "Please try again shortly." });
    return;
  }
  const seen = attempts.get(hash);
  if (seen && seen.until > now && seen.count >= MAX_PER_WINDOW) {
    json(429, { error: "Too many attempts. Please wait a minute." });
    return;
  }
  attempts.set(hash, {
    count: seen && seen.until > now ? seen.count + 1 : 1,
    until: seen && seen.until > now ? seen.until : now + WINDOW_MS,
  });

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req, 8192);
  } catch {
    json(400, { error: "Expected a JSON body." });
    return;
  }

  const text = (key: string, max: number): string | null => {
    const raw = body[key];
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    return trimmed.length === 0 ? null : trimmed.slice(0, max);
  };

  // The idempotency key is the caller's if they sent one — a form that
  // retries on a flaky connection should not create two leads — and ours
  // otherwise, so a missing one never collides with somebody else's.
  const idempotencyKey = text("submission_id", 160) ?? randomUUID();

  const utm: Record<string, string> = {};
  for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) {
    const value = text(key, 200);
    if (value) utm[key] = value;
  }

  const { data, error } = await sb.rpc("capture_lead_v6", {
    p_token_hash: hash,
    p_idempotency_key: idempotencyKey,
    p_name: text("name", 200),
    p_email: text("email", 320),
    p_phone: text("phone", 40),
    p_message: text("message", 4000),
    p_consented: body.consent === true,
    p_evidence: {
      ip_hash: saltedHash(callerIp(req), config.publicIpSalt),
      ua_hash: saltedHash(String(req.headers["user-agent"] ?? ""), config.publicIpSalt),
      received_at: new Date().toISOString(),
    },
    p_click_id: text("gclid", 200) ?? text("fbclid", 200) ?? text("click_id", 200),
    p_utm: Object.keys(utm).length > 0 ? utm : null,
  } as never);

  if (error) {
    // An infrastructure failure is ours, and the caller is told nothing
    // about it beyond that it did not work.
    logger.error("lead_capture_failed", { message: error.message });
    json(503, { error: "That did not go through. Please try again shortly." });
    return;
  }

  const outcome = (data ?? {}) as { ok?: boolean; reason?: string; lead_id?: string };
  if (outcome.ok !== true) {
    // Consent and contactability are the caller's to fix, so those two
    // sentences are passed through. Anything else is the single refusal.
    const theirs =
      outcome.reason === "Consent is required." ||
      outcome.reason === "An email address or a phone number is required.";
    json(theirs ? 400 : 404, { error: theirs ? outcome.reason : REFUSAL });
    return;
  }

  logger.info("lead_captured", { leadId: outcome.lead_id });
  // Identical whether a lead was created or merged. Whether an address is
  // already on file is not a public fact.
  json(200, { ok: true, message: "Thanks — that is with us." });
}
