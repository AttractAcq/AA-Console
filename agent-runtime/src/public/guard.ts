// The rules protecting the one internet-facing, unauthenticated, paid-compute
// endpoint in this system.
//
// Every other route here is reachable only by the console (admin JWT) or the
// gateway (shared secret). This one is reachable by anybody who can read a
// client's page source, so the rules below are the whole defence and they live
// in their own module to be tested directly rather than inferred from a
// handler.
//
// The deployment id in the page is an IDENTIFIER, not a credential. Assume it
// is copied. Nothing here treats possession of it as permission.

import { createHash } from "node:crypto";

/** A visitor's message. Long enough for a real question, short enough not to be a payload. */
export const MAX_MESSAGE_CHARS = 2_000;

/** The widget sends one short message; it never sends history. */
export const MAX_BODY_BYTES = 16 * 1024;

/**
 * Turns of history handed to the model.
 *
 * Bounded because input tokens are billed and an unbounded conversation is an
 * unbounded bill. History is read from the database rather than accepted from
 * the browser, so this caps cost — it is not a trust boundary.
 */
export const MAX_HISTORY_TURNS = 20;

export type DenyReason =
  | "unavailable"
  | "origin"
  | "bad_request"
  | "too_large"
  | "rate_limited"
  | "ceiling"
  | "error";

export interface ClientFacing {
  status: number;
  body: { ok: false; error: string };
}

/**
 * What a refused visitor is told.
 *
 * Deliberately vague about *why* in the cases where the reason is a fact about
 * our configuration. A prober must not be able to tell "no such deployment"
 * from "disabled" from "agent not approved" — if those produced different
 * responses, the endpoint would enumerate the estate. Rate limits and size
 * limits are different: they are facts about the caller's own behaviour, and
 * saying so plainly is what lets a legitimate widget back off.
 */
export function clientFacing(reason: DenyReason): ClientFacing {
  switch (reason) {
    case "unavailable":
    case "origin":
      // One response for both. An origin mismatch must not confirm that the
      // deployment exists.
      return { status: 404, body: { ok: false, error: "This chat is not available." } };
    case "bad_request":
      return { status: 400, body: { ok: false, error: "Send a message." } };
    case "too_large":
      return { status: 413, body: { ok: false, error: "That message is too long." } };
    case "rate_limited":
      return { status: 429, body: { ok: false, error: "Too many messages. Try again shortly." } };
    case "ceiling":
      return { status: 429, body: { ok: false, error: "This chat is unavailable right now." } };
    case "error":
      return { status: 500, body: { ok: false, error: "Something went wrong." } };
  }
}

/**
 * Is this request coming from the one origin this deployment is deployed on?
 *
 * Exact match on scheme+host, no wildcards and no suffix matching: `evil.com`
 * must not pass for `acme.com`, and `acme.com.evil.com` must not pass for
 * `acme.com` — which a `endsWith` check would wave through.
 *
 * A missing Origin is refused. Browsers send Origin on cross-origin POST, so
 * its absence means the caller is not the widget, and the widget is the only
 * thing this endpoint exists to serve.
 */
export function originAllowed(requestOrigin: string | undefined, allowed: string): boolean {
  if (!requestOrigin || !allowed) return false;
  return normaliseOrigin(requestOrigin) === normaliseOrigin(allowed);
}

/** Trailing slashes and case in the host are not meaningful; the path is not an origin. */
export function normaliseOrigin(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

/** A usable visitor message, or the reason it is not one. */
export function validateMessage(raw: unknown): { message: string } | { reason: DenyReason } {
  if (typeof raw !== "string") return { reason: "bad_request" };
  const message = raw.trim();
  if (message.length === 0) return { reason: "bad_request" };
  if (message.length > MAX_MESSAGE_CHARS) return { reason: "too_large" };
  return { message };
}

export type Turn = { role: "user" | "assistant"; content: string };

/**
 * The last N turns, oldest first.
 *
 * Takes from the end because the recent exchange is what the next reply needs;
 * dropping the front of a long conversation loses the opening, which matters
 * less than the bill and the context window.
 */
export function boundHistory(turns: Turn[], max: number = MAX_HISTORY_TURNS): Turn[] {
  const usable = turns.filter(
    (t) => (t.role === "user" || t.role === "assistant") && t.content.trim().length > 0,
  );
  return usable.slice(-max);
}

/**
 * A transcript row out of the database into a model turn.
 *
 * Anything unrecognised is dropped rather than guessed at: a malformed row
 * should cost one turn of context, not the whole conversation.
 */
export function transcriptToTurns(raw: unknown): Turn[] {
  if (!Array.isArray(raw)) return [];
  const out: Turn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const role = row.role;
    const content = typeof row.content === "string" ? row.content.trim() : "";
    if ((role === "user" || role === "assistant") && content) out.push({ role, content });
  }
  return out;
}

/**
 * A stable, non-reversible handle for one caller.
 *
 * Rate limiting needs to recognise a repeat caller, not identify a person. A
 * raw visitor IP on a marketing page is personal data that nothing here needs,
 * so only a salted hash is stored. The salt means the stored value is useless
 * against an IP list if the table ever leaks.
 */
export function hashIp(ip: string | undefined, salt: string): string | null {
  if (!ip) return null;
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

/**
 * The caller's address, from the proxy header Railway sets.
 *
 * The leftmost entry is the original client; the rest are proxies. Taking the
 * last would rate-limit the proxy and throttle every visitor together.
 */
export function callerIp(forwardedFor: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  if (!raw) return undefined;
  const first = raw.split(",")[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

/**
 * The subset of a deployment a browser may see.
 *
 * Allow-listed rather than deny-listed on purpose. The resolver returns the
 * system prompt, guardrails and qualification script in the same row; a
 * deny-list would leak all of it the first time someone added a field.
 */
export function publicConfig(row: {
  greeting: string | null;
  widget_config: unknown;
}): { greeting: string; widget: Record<string, unknown> } {
  const widget =
    row.widget_config && typeof row.widget_config === "object" && !Array.isArray(row.widget_config)
      ? (row.widget_config as Record<string, unknown>)
      : {};
  return {
    greeting: row.greeting?.trim() || "Hello — how can we help?",
    widget: {
      label: typeof widget.label === "string" ? widget.label : "Chat",
      accent: typeof widget.accent === "string" ? widget.accent : null,
      title: typeof widget.title === "string" ? widget.title : null,
    },
  };
}
