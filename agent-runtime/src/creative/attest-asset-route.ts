import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";

import { AuthError } from "../master/auth.js";
import { readJsonBody, UUID } from "../mcp/http.js";

type Identity = {
  asset_id: string;
  client_id: string;
  storage_path: string;
  object_id: string;
  object_version: string | null;
  object_updated_at: string;
};

type FrameIdentity = Identity & { frame_id: string; position: number; caption: string | null };
type FrameSnapshot = { asset_id: string; client_id: string;
  content_format: "carousel" | "story" | "reel"; frames: FrameIdentity[] };

class AttestationError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function validIdentity(value: unknown, clientId: string, assetId: string): value is Identity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.client_id === clientId && v.asset_id === assetId
    && typeof v.storage_path === "string" && !!v.storage_path
    && typeof v.object_id === "string" && UUID.test(v.object_id)
    && (v.object_version === null || typeof v.object_version === "string")
    && typeof v.object_updated_at === "string" && !!v.object_updated_at;
}

function validFrameSnapshot(value: unknown, clientId: string, assetId: string): value is FrameSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (snapshot.client_id !== clientId || snapshot.asset_id !== assetId
    || !["carousel", "story", "reel"].includes(String(snapshot.content_format))
    || !Array.isArray(snapshot.frames)
    || snapshot.frames.length < (snapshot.content_format === "story" ? 1 : 2)) return false;
  return snapshot.frames.every((frame, index) => validIdentity({ ...frame,
    asset_id: assetId, client_id: clientId }, clientId, assetId)
    && typeof frame.frame_id === "string" && UUID.test(frame.frame_id)
    && frame.position === index + 1
    && (frame.caption === null || typeof frame.caption === "string"));
}

async function attestCreativeFrames(sb: SupabaseClient, clientId: string, assetId: string): Promise<void> {
  const initial = await sb.rpc("creative_frame_storage_identities_v8", { p_asset_id: assetId });
  if (initial.error) throw new AttestationError("Could not inspect the creative frames.", 409);
  if (initial.data === null) return;
  if (!validFrameSnapshot(initial.data, clientId, assetId)) {
    throw new AttestationError("Creative frames are incomplete or belong to another client.", 409);
  }
  const verified: Array<{ frame: FrameIdentity; hash: string; bytes: number }> = [];
  for (const frame of initial.data.frames) {
    const file = await sb.storage.from("client-media").download(frame.storage_path);
    if (file.error || !file.data) throw new AttestationError("Could not download a creative frame.", 503);
    const digest = createHash("sha256");
    let bytes = 0;
    const reader = file.data.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      digest.update(value);
    }
    if (!bytes) throw new AttestationError("A creative frame is empty.", 409);
    verified.push({ frame, hash: digest.digest("hex"), bytes });
  }
  const current = await sb.rpc("creative_frame_storage_identities_v8", { p_asset_id: assetId });
  if (current.error || !validFrameSnapshot(current.data, clientId, assetId)
    || current.data.content_format !== initial.data.content_format
    || current.data.frames.length !== initial.data.frames.length
    || current.data.frames.some((frame, index) => {
      const before = initial.data.frames[index];
      return frame.frame_id !== before.frame_id || frame.position !== before.position
        || frame.storage_path !== before.storage_path || frame.caption !== before.caption
        || frame.object_id !== before.object_id
        || frame.object_version !== before.object_version
        || frame.object_updated_at !== before.object_updated_at;
    })) {
    throw new AttestationError("Creative frames changed during verification. Try again.", 409);
  }
  for (const { frame, hash, bytes } of verified) {
    const result = await sb.rpc("attest_creative_frame_bytes_v8", {
      p_asset_id: assetId, p_frame_id: frame.frame_id,
      p_storage_path: frame.storage_path, p_sha256: hash, p_file_bytes: bytes,
      p_object_id: frame.object_id, p_object_version: frame.object_version,
      p_object_updated_at: frame.object_updated_at,
    });
    if (result.error) throw new AttestationError("A frame changed before its evidence was saved.", 409);
  }
}

/** Verify the current Storage object and register the digest of its bytes. */
export async function attestCreativeAssetBytes(
  sb: SupabaseClient, clientId: string, assetId: string, expectedBytes?: Buffer,
): Promise<void> {
  const first = await sb.rpc("creative_storage_identity_v6", { p_asset_id: assetId });
  if (first.error || !validIdentity(first.data, clientId, assetId)) {
    throw new AttestationError("Could not verify this client's current asset file.", 409);
  }
  const file = await sb.storage.from("client-media").download(first.data.storage_path);
  if (file.error || !file.data) {
    throw new AttestationError("Could not download the stored asset file.", 503);
  }
  const digest = createHash("sha256");
  let bytes = 0;
  const reader = file.data.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    digest.update(value);
  }
  if (bytes === 0) throw new AttestationError("The asset file is empty.", 409);
  const sha256 = digest.digest("hex");
  if (expectedBytes && sha256 !== createHash("sha256").update(expectedBytes).digest("hex")) {
    throw new AttestationError("Stored creative bytes differ from the generated file.", 409);
  }
  const second = await sb.rpc("creative_storage_identity_v6", { p_asset_id: assetId });
  if (second.error || !validIdentity(second.data, clientId, assetId)
    || second.data.storage_path !== first.data.storage_path
    || second.data.object_id !== first.data.object_id
    || second.data.object_version !== first.data.object_version
    || second.data.object_updated_at !== first.data.object_updated_at) {
    throw new AttestationError("The asset file changed during verification. Try again.", 409);
  }
  const attested = await sb.rpc("attest_creative_storage_bytes_v6", {
    p_asset_id: assetId, p_storage_path: first.data.storage_path,
    p_sha256: sha256, p_file_bytes: bytes,
    p_object_id: first.data.object_id,
    p_object_version: first.data.object_version,
    p_object_updated_at: first.data.object_updated_at,
  });
  if (attested.error) throw new AttestationError(attested.error.message, 409);
  await attestCreativeFrames(sb, clientId, assetId);
}

async function requireCreativeRequester(
  sb: SupabaseClient, authorization: string | string[] | undefined, clientId: string,
): Promise<void> {
  const raw = Array.isArray(authorization) ? authorization[0] : authorization;
  const token = /^Bearer\s+(.+)$/i.exec(raw?.trim() ?? "")?.[1]?.trim();
  if (!token) throw new AuthError("Missing valid Bearer token.");
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) throw new AuthError("That session is not valid. Sign in again.");
  const userId = data.user.id;
  const [profile, manager, member] = await Promise.all([
    sb.from("profiles").select("role").eq("id", userId).maybeSingle(),
    sb.rpc("active_video_approval_manager", { p_client_id: clientId }),
    sb.from("client_users").select("user_id").eq("client_id", clientId)
      .eq("user_id", userId).maybeSingle(),
  ]);
  if (profile.error || manager.error || member.error) {
    throw new AuthError("Could not verify your client access.", 503);
  }
  if (profile.data?.role !== "admin" && manager.data !== userId && !member.data) {
    throw new AuthError("Only this client's reviewer or account can request creative review.", 403);
  }
}

export async function handleCreativeAssetAttestation(
  req: IncomingMessage,
  res: ServerResponse,
  sb: SupabaseClient,
): Promise<void> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch { return json(400, { ok: false, error: "Expected a JSON body." }); }
  const clientId = String(body.clientId ?? "");
  const assetId = String(body.assetId ?? "");
  if (!UUID.test(clientId) || !UUID.test(assetId)) {
    return json(400, { ok: false, error: "A client and asset are required." });
  }
  try {
    await requireCreativeRequester(sb, req.headers.authorization, clientId);
  } catch (cause) {
    return json(cause instanceof AuthError ? cause.status : 401, {
      ok: false, error: cause instanceof AuthError ? cause.message : "Not permitted.",
    });
  }
  try {
    await attestCreativeAssetBytes(sb, clientId, assetId);
    return json(200, { ok: true, assetId });
  } catch (cause) {
    if (cause instanceof AttestationError) {
      return json(cause.status, { ok: false, error: cause.message });
    }
    return json(503, { ok: false, error: "Stored-file verification is unavailable." });
  }
}
