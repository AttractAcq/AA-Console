import { beforeEach, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";

const { collectSystemReadiness } = vi.hoisted(() => ({ collectSystemReadiness: vi.fn() }));
vi.mock("./collect.js", () => ({ collectSystemReadiness }));
import { handleSystemReadiness } from "./route.js";

/** A request the way the server receives one. The readiness route reports a
 * proxy diagnostic for the admin's own request, which reads the peer address,
 * so a bare object without a socket makes the route throw and answer 503. */
function request(authorization?: string): IncomingMessage {
  return {
    method: "GET",
    headers: { authorization },
    socket: { remoteAddress: "203.0.113.10" },
  } as unknown as IncomingMessage;
}

/** Config with the proxy fields the diagnostic reads. Trusting no proxy is
 * the honest default for a test: the peer is the caller. */
const CONFIG = {
  trustedProxies: { count: 0, blocks: { check: () => false } },
  publicIngressRequired: false,
} as unknown as RuntimeConfig;

function response() {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: vi.fn((key: string, value: string) => { headers[key] = value; }),
    writeHead: vi.fn(), end: vi.fn(),
  };
  return { res: res as unknown as ServerResponse, raw: res, headers };
}

function client(role: string | null): SupabaseClient {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "a@example.com" } }, error: null }) },
    from() { return { select() { return this; }, eq() { return this; },
      async maybeSingle() { return { data: role ? { role } : null, error: null }; } }; },
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  collectSystemReadiness.mockReset();
  collectSystemReadiness.mockResolvedValue({ capturedAt: "2026-10-29T12:00:00Z", schemaVersion: 2 });
});

it("rejects anonymous and non-admin users before service-role inventory reads", async () => {
  for (const [authorization, role, status] of [
    [undefined, "admin", 401], ["Bearer token", "client", 403],
  ] as const) {
    const { res, raw, headers } = response();
    await handleSystemReadiness(request(authorization), res, client(role), CONFIG);
    expect(raw.writeHead).toHaveBeenCalledWith(status, expect.any(Object));
    expect(headers["Cache-Control"]).toBe("no-store");
  }
  expect(collectSystemReadiness).not.toHaveBeenCalled();
});

it("serves the exact inventory only to an active admin session", async () => {
  const { res, raw } = response();
  await handleSystemReadiness(request("Bearer token"), res, client("admin"), CONFIG);
  expect(raw.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  expect(JSON.parse(raw.end.mock.calls[0]![0] as string)).toEqual({
    ok: true, capturedAt: "2026-10-29T12:00:00Z", schemaVersion: 2,
    // The perimeter diagnostic rides along with the inventory. No forwarded
    // header on this request, so the chain is absent and the peer is used.
    requestProxy: {
      directPeer: "203.0.113.10", forwardedHops: [], chainStatus: "absent",
      trustedProxyCount: 0, signedIngressRequired: false,
      callerIpUsedForQuota: "203.0.113.10",
    },
  });
  expect(collectSystemReadiness).toHaveBeenCalledTimes(1);
});
