import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { handleLeadMagnetAttestation } from "./attest-route.js";

const CLIENT = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-000000000002";
const APPROVAL = "00000000-0000-0000-0000-000000000003";
const VERSION = "00000000-0000-0000-0000-000000000004";
const USER = "00000000-0000-0000-0000-000000000005";
const FILE = Buffer.from("exact lead magnet bytes");
const HASH = createHash("sha256").update(FILE).digest("hex");

async function call(sb: SupabaseClient) {
  const req = Readable.from([Buffer.from(JSON.stringify({ clientId: CLIENT, approvalId: APPROVAL }))]) as IncomingMessage;
  req.method = "POST";
  req.headers = { authorization: "Bearer test" };
  let code = 0;
  let payload: { ok?: boolean; error?: string; approvalRequestId?: string } = {};
  const res = {
    writeHead: (status: number) => { code = status; },
    end: (value: string) => { payload = JSON.parse(value) as typeof payload; },
  } as unknown as ServerResponse;
  await handleLeadMagnetAttestation(req, res, sb);
  return { code, payload };
}

function database(options: { approvalClient?: string; storedBytes?: Buffer; hash?: string } = {}) {
  const rpc = vi.fn(async (name: string) => ({
    data: name === "attest_lead_magnet_bytes_v6" ? "request-1" : null, error: null,
  }));
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: table === "profiles" ? { role: "admin" }
        : table === "lead_magnet_approvals"
          ? { id: APPROVAL, client_id: options.approvalClient ?? CLIENT,
              magnet_version_id: VERSION, status: "pending", inbox_enforced_v6: true }
          : { id: VERSION, client_id: CLIENT, storage_path: "lead-magnets/file.pdf",
              content_sha256: options.hash ?? HASH, file_bytes: FILE.length }, error: null }),
    });
    return chain;
  });
  const sb = {
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
    from, rpc,
    storage: { from: () => ({ download: async () => ({
      data: new Blob([new Uint8Array(options.storedBytes ?? FILE)]), error: null,
    }) }) },
  } as unknown as SupabaseClient;
  return { sb, rpc };
}

describe("trusted lead magnet byte attestation", () => {
  it("refuses a stored version with changed bytes", async () => {
    const { sb, rpc } = database({ storedBytes: Buffer.from("different bytes") });
    const result = await call(sb);
    expect(result.code).toBe(409);
    expect(rpc).not.toHaveBeenCalledWith("attest_lead_magnet_bytes_v6", expect.anything());
  });

  it("refuses an approval belonging to another client", async () => {
    const { sb, rpc } = database({ approvalClient: OTHER });
    const result = await call(sb);
    expect(result.code).toBe(404);
    expect(rpc).not.toHaveBeenCalledWith("attest_lead_magnet_bytes_v6", expect.anything());
  });

  it("attests only the hash and size computed from stored bytes", async () => {
    const { sb, rpc } = database();
    const result = await call(sb);
    expect(result.code).toBe(200);
    expect(result.payload.approvalRequestId).toBe("request-1");
    expect(rpc).toHaveBeenCalledWith("attest_lead_magnet_bytes_v6", {
      p_approval_id: APPROVAL, p_sha256: HASH, p_file_bytes: FILE.length,
    });
  });
});
