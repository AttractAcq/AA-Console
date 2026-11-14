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

function validIdentity(value: unknown, clientId: string, assetId: string): value is Identity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.client_id === clientId && v.asset_id === assetId
    && typeof v.storage_path === "string" && !!v.storage_path
    && typeof v.object_id === "string" && UUID.test(v.object_id)
    && (v.object_version === null || typeof v.object_version === "string")
    && typeof v.object_updated_at === "string" && !!v.object_updated_at;
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
    const first = await sb.rpc("creative_storage_identity_v6", { p_asset_id: assetId });
    if (first.error || !validIdentity(first.data, clientId, assetId)) {
      return json(409, { ok: false, error: "Could not verify this client's current asset file." });
    }
    const file = await sb.storage.from("client-media").download(first.data.storage_path);
    if (file.error || !file.data) {
      return json(503, { ok: false, error: "Could not download the stored asset file." });
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
    if (bytes === 0) return json(409, { ok: false, error: "The asset file is empty." });
    const second = await sb.rpc("creative_storage_identity_v6", { p_asset_id: assetId });
    if (second.error || !validIdentity(second.data, clientId, assetId)
      || second.data.storage_path !== first.data.storage_path
      || second.data.object_id !== first.data.object_id
      || second.data.object_version !== first.data.object_version
      || second.data.object_updated_at !== first.data.object_updated_at) {
      return json(409, { ok: false, error: "The asset file changed during verification. Try again." });
    }
    const attested = await sb.rpc("attest_creative_storage_bytes_v6", {
      p_asset_id: assetId, p_storage_path: first.data.storage_path,
      p_sha256: digest.digest("hex"), p_file_bytes: bytes,
      p_object_id: first.data.object_id,
      p_object_version: first.data.object_version,
      p_object_updated_at: first.data.object_updated_at,
    });
    if (attested.error) return json(409, { ok: false, error: attested.error.message });
    return json(200, { ok: true, assetId });
  } catch {
    return json(503, { ok: false, error: "Stored-file verification is unavailable." });
  }
}
