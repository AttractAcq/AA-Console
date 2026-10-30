import { beforeEach, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";

const { collectSchemaParity } = vi.hoisted(() => ({ collectSchemaParity: vi.fn() }));
vi.mock("./schema-parity-live.js", () => ({
  collectSchemaParity,
  schemaParityConfig: (config: RuntimeConfig) => config.schemaParityReadToken ? { token: config.schemaParityReadToken } : null,
}));
import { handleSchemaParity } from "./schema-parity-route.js";

function response() {
  const headers: Record<string, string> = {};
  const res = { setHeader: vi.fn((key: string, value: string) => { headers[key] = value; }), writeHead: vi.fn(), end: vi.fn() };
  return { res: res as unknown as ServerResponse, raw: res, headers };
}
function client(role: string | null): SupabaseClient {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "a@example.com" } }, error: null }) },
    from() { return { select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: role ? { role } : null, error: null }; } }; },
  } as unknown as SupabaseClient;
}

beforeEach(() => { collectSchemaParity.mockReset(); collectSchemaParity.mockResolvedValue({ schemaVersion: 1, result: "drift" }); });

it("checks the database-backed admin role before querying either project", async () => {
  for (const [authorization, role, status] of [[undefined, "admin", 401], ["Bearer token", "client", 403]] as const) {
    const { res, raw, headers } = response();
    await handleSchemaParity({ method: "GET", headers: { authorization } } as IncomingMessage,
      res, client(role), { schemaParityReadToken: "scoped" } as RuntimeConfig);
    expect(raw.writeHead).toHaveBeenCalledWith(status, expect.any(Object));
    expect(headers["Cache-Control"]).toBe("no-store");
  }
  expect(collectSchemaParity).not.toHaveBeenCalled();
});

it("fails closed when read access is unconfigured and serves an admin a redacted report", async () => {
  const first = response();
  await handleSchemaParity({ method: "GET", headers: { authorization: "Bearer token" } } as IncomingMessage,
    first.res, client("admin"), { schemaParityReadToken: null } as RuntimeConfig);
  expect(first.raw.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
  expect(collectSchemaParity).not.toHaveBeenCalled();

  const second = response();
  await handleSchemaParity({ method: "GET", headers: { authorization: "Bearer token" } } as IncomingMessage,
    second.res, client("admin"), { schemaParityReadToken: "scoped" } as RuntimeConfig);
  expect(second.raw.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  expect(JSON.parse(second.raw.end.mock.calls[0]![0] as string)).toEqual({ ok: true, schemaVersion: 1, result: "drift" });
  expect(collectSchemaParity).toHaveBeenCalledTimes(1);
});
