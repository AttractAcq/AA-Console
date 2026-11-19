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
const FRAMES = [
  { ...IDENTITY, frame_id: "00000000-0000-0000-0000-000000000011", position: 1, caption: "First" },
  { ...IDENTITY, frame_id: "00000000-0000-0000-0000-000000000012", position: 2,
    storage_path: `${CLIENT}/${ASSET}/frame-2.png`, caption: "Second",
    object_id: "00000000-0000-0000-0000-000000000014" },
];

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

function database(options: { identityClient?: string; secondVersion?: string; role?: string;
  clientMember?: boolean; frames?: boolean; changedFrame?: boolean } = {}) {
  let identities = 0;
  let frameReads = 0;
  const rpc = vi.fn(async (name: string, _args?: Record<string, unknown>) => {
    if (name === "creative_storage_identity_v6") {
      identities += 1;
      return { data: { ...IDENTITY, client_id: options.identityClient ?? CLIENT,
        object_version: identities === 2 ? options.secondVersion ?? "v1" : "v1" }, error: null };
    }
    if (name === "creative_frame_storage_identities_v8") {
      frameReads += 1;
      return { data: options.frames ? { client_id: CLIENT, asset_id: ASSET,
        content_format: "carousel", frames: FRAMES.map((frame) => ({ ...frame,
          object_version: options.changedFrame && frameReads === 2 && frame.position === 2 ? "v2" : "v1" })) } : null,
      error: null };
    }
    return { data: name === "attest_creative_storage_bytes_v6" ? ASSET : null, error: null };
  });
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, { select: () => chain, eq: () => chain,
      maybeSingle: async () => ({ data: table === "client_users"
        ? options.clientMember ? { user_id: ACTOR } : null
        : { role: options.role ?? "admin" }, error: null }) });
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

  it("lets a linked client account request byte verification for its own asset", async () => {
    const { sb } = database({ role: "client", clientMember: true });
    expect((await call(sb)).code).toBe(200);
  });

  it("hashes and records every frame of a multi-file creative", async () => {
    const { sb, rpc } = database({ frames: true });
    expect((await call(sb)).code).toBe(200);
    const calls = rpc.mock.calls.filter(([name]) => name === "attest_creative_frame_bytes_v8");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[1]).toMatchObject({ p_frame_id: FRAMES[1]!.frame_id,
      p_storage_path: FRAMES[1]!.storage_path, p_sha256: HASH, p_file_bytes: FILE.length });
  });

  it("refuses changed frame identity before saving any frame attestations", async () => {
    const { sb, rpc } = database({ frames: true, changedFrame: true });
    expect((await call(sb)).code).toBe(409);
    expect(rpc).not.toHaveBeenCalledWith("attest_creative_frame_bytes_v8", expect.anything());
  });
});
