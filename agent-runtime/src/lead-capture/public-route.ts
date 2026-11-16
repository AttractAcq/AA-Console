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
import { admitPublicRequest, saltedPublicHash } from "../public/quota.js";

/** Same construction as the proof portal's, so one salt covers both. */
export const hashCaptureToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

/** The one thing every refusal says. */
const REFUSAL = "This form is not accepting submissions.";
const FORM_PATH = /^\/public\/lead\/form\/([a-f0-9]{64})$/;

async function readFormBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    throw new Error("Expected a browser form.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  const timeout = setTimeout(() => req.destroy(new Error("Form read timed out.")), 10_000);
  timeout.unref();
  try {
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 8192) throw new Error("Form too large.");
      chunks.push(bytes);
    }
  } finally {
    clearTimeout(timeout);
  }
  const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  const body: Record<string, unknown> = Object.fromEntries(params);
  body.consent = params.get("consent") === "yes";
  return body;
}

export async function handlePublicLead(
  req: IncomingMessage,
  res: ServerResponse,
  sb: SupabaseClient,
  config: RuntimeConfig,
): Promise<void> {
  const formToken = FORM_PATH.exec(req.url ?? "")?.[1] ?? null;
  const isForm = formToken !== null;
  const json = (status: number, body: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      // A campaign page is hosted on the client's own domain. The token is
      // already a public form capability; quota and expiry still apply to
      // every POST, including calls from a different browser origin.
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    });
    res.end(JSON.stringify(body));
  };

  const formResult = (status: number, success: boolean) => {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    });
    res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${success ? "Message received" : "Submission unavailable"}</title><main style="max-width:42rem;margin:4rem auto;padding:1rem;font:1.1rem system-ui"><h1>${success ? "Thank you" : "That did not go through"}</h1><p>${success ? "Your message is with the team." : "Please return to the page and try again, or contact the business directly."}</p></main></html>`);
  };

  if (req.url !== "/public/lead/submit" && !isForm) {
    json(404, { error: "Not found" });
    return;
  }
  if (!isForm && req.method === "OPTIONS") {
    json(204, {});
    return;
  }
  if (req.method !== "POST") {
    if (isForm) formResult(404, false);
    else json(404, { error: "Not found" });
    return;
  }

  const rawAuthorization = isForm ? `Bearer ${formToken}` : req.headers.authorization ?? "";
  const admitted = await admitPublicRequest(req, sb, config, "lead_submit", rawAuthorization);
  if (!admitted.allowed) {
    if (isForm) { formResult(admitted.reason === "quota" ? 429 : 503, false); return; }
    json(admitted.reason === "quota" ? 429 : 503, {
      error: admitted.reason === "quota" ? "Please try again shortly." : "That did not go through. Please try again shortly.",
    });
    return;
  }
  const token = rawAuthorization.replace(/^Bearer /, "");
  if (!/^[a-f0-9]{64}$/.test(token)) {
    if (isForm) { formResult(404, false); return; }
    json(404, { error: REFUSAL });
    return;
  }
  const hash = hashCaptureToken(token);

  let body: Record<string, unknown>;
  try {
    body = isForm ? await readFormBody(req) : await readJsonBody(req, 8192);
  } catch {
    if (isForm) { formResult(400, false); return; }
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
      ip_hash: admitted.ipHash.slice(0, 32),
      ua_hash: saltedPublicHash(String(req.headers["user-agent"] ?? ""), config.publicIpSalt).slice(0, 32),
      received_at: new Date().toISOString(),
    },
    p_click_id: text("gclid", 200) ?? text("fbclid", 200) ?? text("click_id", 200),
    p_utm: Object.keys(utm).length > 0 ? utm : null,
  } as never);

  if (error) {
    // An infrastructure failure is ours, and the caller is told nothing
    // about it beyond that it did not work.
    logger.error("lead_capture_failed", { reason: "database_error" });
    if (isForm) { formResult(503, false); return; }
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
    if (isForm) { formResult(theirs ? 400 : 404, false); return; }
    json(theirs ? 400 : 404, { error: theirs ? outcome.reason : REFUSAL });
    return;
  }

  logger.info("lead_captured", { leadId: outcome.lead_id });
  if (isForm) { formResult(200, true); return; }
  // Identical whether a lead was created or merged. Whether an address is
  // already on file is not a public fact.
  json(200, { ok: true, message: "Thanks — that is with us." });
}
