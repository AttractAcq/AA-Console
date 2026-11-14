import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { handleCreativeAssetAttestation } from "./attest-asset-route.js";

const CLIENT = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-000000000002";
const ASSET = "00000000-0000-0000-0000-000000000003";
const OBJECT = "00000000-0000-0000-0000-000000000004";
const ACTOR = "00000000-0000-0000-0000-000000000005";
const FILE = Buffer.from("exact stored creative bytes");
const HASH = createHash("sha256").update(FILE).digest("hex");
const IDENTITY = { client_id: CLIENT, asset_id: ASSET,
  storage_path: `${CLIENT}/${ASSET}/render.png`, object_id: OBJECT,
  object_version: "v1", object_updated_at: "2026-11-14T10:00:00Z" };

async function call(sb: SupabaseClient) {
  const req = Readable.from([Buffer.from(JSON.stringify({ clientId: CLIENT, assetId: ASSET,
    sha256: "browser-must-not-supply-a-hash" }))]) as IncomingMessage;
  req.method = "POST";
  req.headers = { authorization: "Bearer test" };
  let code = 0;
  let payload: { ok?: boolean; error?: string; assetId?: string } = {};
  const res = {
    writeHead: (status: number) => { code = status; },
    end: (value: string) => { payload = JSON.parse(value) as typeof payload; },
  } as unknown as ServerResponse;
  await handleCreativeAssetAttestation(req, res, sb);
  return { code, payload };
}

function database(options: { identityClient?: string; secondVersion?: string; role?: string } = {}) {
  let identities = 0;
  const rpc = vi.fn(async (name: string) => {
    if (name === "creative_storage_identity_v6") {
      identities += 1;
      return { data: { ...IDENTITY, client_id: options.identityClient ?? CLIENT,
        object_version: identities === 2 ? options.secondVersion ?? "v1" : "v1" }, error: null };
    }
    return { data: name === "attest_creative_storage_bytes_v6" ? ASSET : null, error: null };
  });
  const from = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, { select: () => chain, eq: () => chain,
      maybeSingle: async () => ({ data: { role: options.role ?? "admin" }, error: null }) });
    return chain;
  });
  const sb = {
    auth: { getUser: async () => ({ data: { user: { id: ACTOR } }, error: null }) },
    from, rpc,
    storage: { from: () => ({ download: async () => ({
      data: new Blob([new Uint8Array(FILE)]), error: null,
    }) }) },
  } as unknown as SupabaseClient;
  return { sb, rpc };
}

describe("trusted creative byte attestation", () => {
  it("registers only the downloaded bytes and stable Storage identity", async () => {
    const { sb, rpc } = database();
    const result = await call(sb);
    expect(result).toEqual({ code: 200, payload: { ok: true, assetId: ASSET } });
    expect(rpc).toHaveBeenCalledWith("attest_creative_storage_bytes_v6", {
      p_asset_id: ASSET, p_storage_path: IDENTITY.storage_path,
      p_sha256: HASH, p_file_bytes: FILE.length,
      p_object_id: OBJECT, p_object_version: "v1",
      p_object_updated_at: IDENTITY.object_updated_at,
    });
  });

  it("refuses an asset changed during download", async () => {
    const { sb, rpc } = database({ secondVersion: "v2" });
    expect((await call(sb)).code).toBe(409);
    expect(rpc).not.toHaveBeenCalledWith("attest_creative_storage_bytes_v6", expect.anything());
  });

  it("refuses another client's asset identity", async () => {
    const { sb, rpc } = database({ identityClient: OTHER });
    expect((await call(sb)).code).toBe(409);
    expect(rpc).not.toHaveBeenCalledWith("attest_creative_storage_bytes_v6", expect.anything());
  });

  it("refuses an unprovisioned caller", async () => {
    const { sb, rpc } = database({ role: "client" });
    expect((await call(sb)).code).toBe(403);
    expect(rpc).not.toHaveBeenCalledWith("creative_storage_identity_v6", expect.anything());
  });
});
