import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import { expect, it, vi } from "vitest";
import { handleProofCaptureAdmin } from "./admin-route.js";
const clientId = "00000000-0000-0000-0000-000000000001";
async function call(
  sb: SupabaseClient,
  path = "/admin/proof-capture",
  token = "test",
) {
  const req = Readable.from([
    Buffer.from(JSON.stringify({ clientId, action: "create_link" })),
  ]) as IncomingMessage;
  req.method = "POST";
  req.url = path;
  req.headers = { authorization: `Bearer ${token}` };
  let code = 0;
  const res = {
    writeHead: (c: number) => {
      code = c;
    },
    end: () => {},
  } as unknown as ServerResponse;
  await handleProofCaptureAdmin(req, res, sb, {
    mcpServiceSecret: "internal-secret",
  } as RuntimeConfig);
  return code;
}
it("requires a valid session for console access", async () => {
  const from = vi.fn();
  expect(
    await call({
      auth: {
        getUser: async () => ({ data: { user: null }, error: new Error() }),
      },
      from,
    } as unknown as SupabaseClient),
  ).toBe(401);
  expect(from).not.toHaveBeenCalled();
});
it("rejects users who are neither admins nor assigned managers", async () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: { role: "smm" }, error: null }),
  };
  const sb = {
    auth: {
      getUser: async () => ({ data: { user: { id: "other" } }, error: null }),
    },
    from: () => chain,
    rpc: async () => ({ data: "assigned-manager", error: null }),
  } as unknown as SupabaseClient;
  expect(await call(sb)).toBe(403);
});
it("rejects incorrect internal secrets before reading client data", async () => {
  const from = vi.fn();
  expect(
    await call(
      { from } as unknown as SupabaseClient,
      "/internal/proof-capture/event",
      "incorrect",
    ),
  ).toBe(401);
  expect(from).not.toHaveBeenCalled();
});
