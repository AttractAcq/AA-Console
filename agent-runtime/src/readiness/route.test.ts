import { beforeEach, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import { parseTrustedProxies } from "../public/client-ip.js";

const { collectSystemReadiness } = vi.hoisted(() => ({ collectSystemReadiness: vi.fn() }));
vi.mock("./collect.js", () => ({ collectSystemReadiness }));
import { handleSystemReadiness } from "./route.js";

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
    await handleSystemReadiness({ method: "GET", headers: { authorization,
      "x-forwarded-for": "203.0.113.88" }, socket: { remoteAddress: "10.0.0.2" } } as unknown as IncomingMessage,
      res, client(role), {} as RuntimeConfig);
    expect(raw.writeHead).toHaveBeenCalledWith(status, expect.any(Object));
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(raw.end.mock.calls[0]?.[0]).not.toContain("203.0.113.88");
  }
  expect(collectSystemReadiness).not.toHaveBeenCalled();
});

it("serves the exact inventory only to an active admin session", async () => {
  const { res, raw } = response();
  const req = { method: "GET", headers: { authorization: "Bearer token",
    "x-forwarded-for": "203.0.113.6, 10.0.0.1" },
    socket: { remoteAddress: "10.0.0.2" } } as unknown as IncomingMessage;
  await handleSystemReadiness(req, res, client("admin"), {
    trustedProxies: parseTrustedProxies(undefined),
  } as RuntimeConfig);
  expect(raw.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  expect(JSON.parse(raw.end.mock.calls[0]![0] as string)).toEqual({
    ok: true, capturedAt: "2026-10-29T12:00:00Z", schemaVersion: 2,
    requestProxy: { directPeer: "10.0.0.2", forwardedHops: ["203.0.113.6", "10.0.0.1"],
      chainStatus: "ignored_untrusted_peer", trustedProxyCount: 0, signedIngressRequired: false,
      callerIpUsedForQuota: "10.0.0.2" },
  });
  expect(collectSystemReadiness).toHaveBeenCalledTimes(1);
});
