import { beforeEach, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";

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
  collectSystemReadiness.mockResolvedValue({ capturedAt: "2026-10-29T12:00:00Z", schemaVersion: 1 });
});

it("rejects anonymous and non-admin users before service-role inventory reads", async () => {
  for (const [authorization, role, status] of [
    [undefined, "admin", 401], ["Bearer token", "client", 403],
  ] as const) {
    const { res, raw, headers } = response();
    await handleSystemReadiness({ method: "GET", headers: { authorization } } as IncomingMessage,
      res, client(role), {} as RuntimeConfig);
    expect(raw.writeHead).toHaveBeenCalledWith(status, expect.any(Object));
    expect(headers["Cache-Control"]).toBe("no-store");
  }
  expect(collectSystemReadiness).not.toHaveBeenCalled();
});

it("serves the exact inventory only to an active admin session", async () => {
  const { res, raw } = response();
  await handleSystemReadiness({ method: "GET", headers: { authorization: "Bearer token" } } as IncomingMessage,
    res, client("admin"), {} as RuntimeConfig);
  expect(raw.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  expect(JSON.parse(raw.end.mock.calls[0]![0] as string)).toEqual({
    ok: true, capturedAt: "2026-10-29T12:00:00Z", schemaVersion: 1,
  });
  expect(collectSystemReadiness).toHaveBeenCalledTimes(1);
});
