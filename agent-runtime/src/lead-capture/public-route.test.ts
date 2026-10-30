import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeConfig } from "../config.js";
import { parseTrustedProxies } from "../public/client-ip.js";
import { handlePublicLead, hashCaptureToken } from "./public-route.js";

/**
 * The doorway, not the decision.
 *
 * `capture_lead_v6` decides whether a submission becomes a lead, and
 * lead-capture.pg.test.ts asserts that against a real Postgres. What is
 * worth asserting here is what a hostile caller can learn: nothing about
 * which endpoints are live, nothing about which client owns one, and
 * nothing about whether an address is already on file.
 */

const TOKEN = "a".repeat(64);
const config = { publicIpSalt: "a-salt", trustedProxies: parseTrustedProxies(undefined) } as RuntimeConfig;

/** A different token per call unless a test pins one. */
let issued = 0;
const freshToken = () => (issued += 1).toString(16).padStart(64, "0");

function call(
  sb: SupabaseClient,
  options: { token?: string; body?: Record<string, unknown>; method?: string; url?: string } = {},
) {
  const req = Readable.from([
    Buffer.from(JSON.stringify(options.body ?? { email: "jay@example.test", consent: true })),
  ]) as IncomingMessage;
  req.method = options.method ?? "POST";
  req.url = options.url ?? "/public/lead/submit";
  req.headers = {
    authorization: `Bearer ${options.token ?? freshToken()}`,
    "user-agent": "Mozilla/5.0",
    "x-forwarded-for": "203.0.113.9, 10.0.0.1",
  };
  Object.defineProperty(req, "socket", { value: { remoteAddress: "10.0.0.1" } });

  let code = 0;
  let payload: Record<string, unknown> = {};
  const res = {
    writeHead: (c: number) => {
      code = c;
    },
    end: (text: string) => {
      payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    },
  } as unknown as ServerResponse;

  return handlePublicLead(req, res, sb, config).then(() => ({ code, payload }));
}

function database(outcome: Record<string, unknown> | null, error?: string) {
  // Typed with its arguments so the assertions below can read them.
  const counts = new Map<string, number>();
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "admit_public_route_v6") {
      const key = String(args.p_subject_hash);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { data: count <= 10, error: null };
    }
    return error ? { data: null, error: { message: error } } : { data: outcome, error: null };
  });
  return { sb: { rpc } as unknown as SupabaseClient, rpc };
}

/** The arguments of one rpc call, which the mock's typing guarantees exist. */
const argsOf = (
  rpc: ReturnType<typeof database>["rpc"],
  index = 0,
): Record<string, unknown> => rpc.mock.calls.filter(([name]) => name === "capture_lead_v6")[index]![1];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("what reaches the database", () => {
  it("passes the hashed token, never the token", async () => {
    const { sb, rpc } = database({ ok: true, lead_id: "lead-1", created: true });
    await call(sb, { token: TOKEN });
    const args = argsOf(rpc);
    expect(args.p_token_hash).toBe(hashCaptureToken(TOKEN));
    expect(JSON.stringify(args)).not.toContain(TOKEN);
  });

  it("hashes the caller's ip and user agent rather than storing them", async () => {
    const { sb, rpc } = database({ ok: true, lead_id: "lead-1" });
    await call(sb);
    const evidence = argsOf(rpc).p_evidence as Record<string, string>;
    expect(evidence.ip_hash).toMatch(/^[a-f0-9]{32}$/);
    expect(evidence.ua_hash).toMatch(/^[a-f0-9]{32}$/);
    // The raw values are personal data and answer no question a hash cannot.
    expect(JSON.stringify(evidence)).not.toContain("203.0.113.9");
    expect(JSON.stringify(evidence)).not.toContain("Mozilla");
  });

  it("collects the click id and the utm parameters that were sent", async () => {
    const { sb, rpc } = database({ ok: true, lead_id: "lead-1" });
    await call(sb, {
      body: {
        email: "jay@example.test",
        consent: true,
        gclid: "abc123",
        utm_source: "google",
        utm_medium: "cpc",
        utm_nonsense: "ignored",
      },
    });
    const args = argsOf(rpc);
    expect(args.p_click_id).toBe("abc123");
    expect(args.p_utm).toEqual({ utm_source: "google", utm_medium: "cpc" });
  });

  it("uses the caller's submission id so a retry is not a second lead", async () => {
    const { sb, rpc } = database({ ok: true, lead_id: "lead-1" });
    await call(sb, { body: { email: "jay@example.test", consent: true, submission_id: "form-99" } });
    expect(argsOf(rpc).p_idempotency_key).toBe("form-99");
  });

  it("invents one when the caller sends none, rather than colliding", async () => {
    const { sb, rpc } = database({ ok: true, lead_id: "lead-1" });
    await call(sb);
    await call(sb);
    const first = argsOf(rpc, 0).p_idempotency_key;
    const second = argsOf(rpc, 1).p_idempotency_key;
    expect(first).not.toBe(second);
  });

  it("treats a missing consent flag as no consent", async () => {
    const { sb, rpc } = database({ ok: false, reason: "Consent is required." });
    await call(sb, { body: { email: "jay@example.test" } });
    expect(argsOf(rpc).p_consented).toBe(false);
  });
});

describe("what a stranger can learn", () => {
  it("says the same thing for a malformed token as for a dead endpoint", async () => {
    const malformed = await call(database(null).sb, { token: "nope" });
    const dead = await call(database({ ok: false, reason: "This form has reached its limit." }).sb);
    expect(malformed.payload.error).toBe("This form is not accepting submissions.");
    expect(dead.payload.error).toBe("This form is not accepting submissions.");
    expect(malformed.code).toBe(404);
    expect(dead.code).toBe(404);
  });

  it("charges quota but does not look up a malformed token", async () => {
    const { sb, rpc } = database(null);
    await call(sb, { token: "nope" });
    expect(rpc).toHaveBeenCalledWith("admit_public_route_v6", expect.anything());
    expect(rpc).not.toHaveBeenCalledWith("capture_lead_v6", expect.anything());
  });

  it("answers identically whether a lead was created or merged", async () => {
    const created = await call(database({ ok: true, lead_id: "lead-1", created: true }).sb);
    const merged = await call(database({ ok: true, lead_id: "lead-1", created: false }).sb);
    // Whether an address is already on file is not a public fact.
    expect(created.payload).toEqual(merged.payload);
    expect(created.payload).toEqual({ ok: true, message: "Thanks — that is with us." });
  });

  it("passes back only the two refusals the caller can act on", async () => {
    const consent = await call(database({ ok: false, reason: "Consent is required." }).sb);
    expect(consent.code).toBe(400);
    expect(consent.payload.error).toBe("Consent is required.");

    const contact = await call(
      database({ ok: false, reason: "An email address or a phone number is required." }).sb,
    );
    expect(contact.code).toBe(400);

    const internal = await call(database({ ok: false, reason: "Some internal detail." }).sb);
    expect(internal.code).toBe(404);
    expect(internal.payload.error).toBe("This form is not accepting submissions.");
  });

  it("hides an infrastructure failure behind a retry message", async () => {
    const { sb } = database(null, "connection reset");
    const { code, payload } = await call(sb);
    expect(code).toBe(503);
    expect(String(payload.error)).not.toContain("connection reset");
  });

  it("serves nothing but the one route and the one method", async () => {
    expect((await call(database(null).sb, { method: "GET" })).code).toBe(404);
    expect((await call(database(null).sb, { url: "/public/lead" })).code).toBe(404);
  });
});

describe("rate limiting", () => {
  it("refuses a quota-store failure before body processing or token lookup", async () => {
    const rpc = vi.fn(async (name: string) => name === "admit_public_route_v6"
      ? { data: null, error: { message: "database unavailable" } }
      : { data: { ok: true }, error: null });
    const { code, payload } = await call({ rpc } as unknown as SupabaseClient, {
      token: "d".repeat(64), body: { message: "x".repeat(20_000) },
    });
    expect(code).toBe(503);
    expect(String(payload.error)).not.toContain("database unavailable");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]?.[0]).toBe("admit_public_route_v6");
  });

  it("stops a script on one token without blocking everyone", async () => {
    const { sb } = database({ ok: true, lead_id: "lead-1" });
    const token = "b".repeat(64);
    let limited = 0;
    for (let i = 0; i < 14; i += 1) {
      const { code } = await call(sb, { token });
      if (code === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
    // A different token is a different counter.
    expect((await call(sb, { token: "c".repeat(64) })).code).toBe(200);
  });
});
