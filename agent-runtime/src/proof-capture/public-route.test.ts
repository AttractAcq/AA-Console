import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import { parseTrustedProxies } from "../public/client-ip.js";
import { expect, it, vi } from "vitest";
import { handlePublicProof, hashCaptureToken } from "./public-route.js";
const token = "a".repeat(64);
const config = { publicIpSalt: "test-salt", trustedProxies: parseTrustedProxies(undefined) } as RuntimeConfig;
async function run(
  url: string,
  body: unknown,
  sb: SupabaseClient,
  method = "POST",
  auth = token,
) {
  const req = Readable.from([
    Buffer.from(JSON.stringify(body)),
  ]) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { authorization: `Bearer ${auth}` };
  Object.defineProperty(req, "socket", { value: { remoteAddress: "203.0.113.9" } });
  const result = { status: 0, headers: {} as Record<string, string>, body: "" };
  const res = {
    writeHead: (status: number, headers: Record<string, string>) => {
      result.status = status;
      result.headers = headers;
    },
    end: (body: string) => {
      result.body = body;
    },
  } as unknown as ServerResponse;
  await handlePublicProof(req, res, sb, config);
  return result;
}
function database(revoked = false) {
  const lookup = vi.fn();
  const rpc = vi.fn(async (name: string) => ({ data: name === "admit_public_route_v6" ? true : "proof", error: null }));
  return {
    lookup,
    rpc,
    sb: {
      from: (table: string) => {
        const chain = {
          select: () => chain,
          eq: (key: string, value: unknown) => {
            lookup(table, key, value);
            return chain;
          },
          maybeSingle: async () => ({
            error: null,
            data:
              table === "proof_capture_links"
                ? {
                    id: "link",
                    client_id: "client",
                    config_id: "config",
                    expires_at: new Date(Date.now() + 86400000).toISOString(),
                    revoked_at: revoked ? "now" : null,
                    submissions: 0,
                    max_submissions: 1,
                  }
                : table === "proof_capture_configs"
                  ? { name: "Evidence", instructions: "Actual results only" }
                  : null,
          }),
        };
        return chain;
      },
      rpc,
    } as unknown as SupabaseClient,
  };
}
it("serves no-store portal with per-response CSP nonce", async () => {
  const r = await run("/public/proof", {}, {} as SupabaseClient, "GET");
  expect(r.status).toBe(200);
  expect(r.headers["Cache-Control"]).toBe("no-store");
  expect(r.headers["Content-Security-Policy"]).toContain(
    "frame-ancestors 'none'",
  );
  expect(r.body).not.toContain("__NONCE__");
});
it("rejects missing and revoked tokens", async () => {
  const { sb, rpc } = database(true);
  const malformed = await run("/public/proof/config", {}, sb, "POST", "invalid");
  const revoked = await run("/public/proof/config", {}, sb);
  expect(malformed.status).toBe(404);
  expect(revoked.status).toBe(404);
  expect(malformed.body).toBe(revoked.body);
  expect(rpc).not.toHaveBeenCalledWith("accept_proof_capture_submission", expect.anything());
});
it("checks the shared quota before link lookup or large body parsing", async () => {
  const lookup = vi.fn(() => { throw new Error("must not look up"); });
  const rpc = vi.fn(async () => ({ data: false, error: null }));
  const result = await run("/public/proof/submit", { consent: false },
    { rpc, from: lookup } as unknown as SupabaseClient);
  expect(result.status).toBe(429);
  expect(lookup).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledTimes(1);
});
it("looks up hash and scopes setup to link client", async () => {
  const { sb, lookup } = database();
  expect((await run("/public/proof/config", {}, sb)).status).toBe(200);
  expect(lookup).toHaveBeenCalledWith(
    "proof_capture_links",
    "token_hash",
    hashCaptureToken(token),
  );
  expect(lookup).toHaveBeenCalledWith(
    "proof_capture_configs",
    "client_id",
    "client",
  );
});
it("requires consent then persists through atomic RPC", async () => {
  const { sb, rpc } = database();
  const body = {
    submissionId: "00000000-0000-0000-0000-000000000001",
    name: "Alex",
    body: "Actual completed work",
    category: "customers",
    kind: "Online Reviews",
    consent: false,
  };
  expect((await run("/public/proof/submit", body, sb)).status).toBe(400);
  expect(rpc).not.toHaveBeenCalledWith("accept_proof_capture_submission", expect.anything());
  expect(
    (await run("/public/proof/submit", { ...body, consent: true }, sb)).status,
  ).toBe(200);
  expect(rpc).toHaveBeenCalledWith(
    "accept_proof_capture_submission",
    expect.objectContaining({
      p_token_hash: hashCaptureToken(token),
      p_body: body.body,
      p_storage_path: null,
    }),
  );
});
