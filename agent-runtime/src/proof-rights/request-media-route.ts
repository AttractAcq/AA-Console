// A manager supplies the proof ID and permission basis. Only this trusted
// route reads the private stored file and supplies its actual digest to SQL.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";

import { AuthError, requireAdminOrClientManager } from "../master/auth.js";
import { readJsonBody, UUID } from "../mcp/http.js";

type Identity = {
  client_id: string;
  proof_id: string;
  storage_path: string;
  object_id: string;
  object_version: string | null;
  object_updated_at: string;
};

function validIdentity(value: unknown, clientId: string, proofId: string): value is Identity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.client_id === clientId && v.proof_id === proofId
    && typeof v.storage_path === "string" && !!v.storage_path
    && typeof v.object_id === "string" && UUID.test(v.object_id)
    && (v.object_version === null || typeof v.object_version === "string")
    && typeof v.object_updated_at === "string" && !!v.object_updated_at;
}

export async function handleProofMediaRightsRequest(
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
  const proofId = String(body.proofId ?? "");
  const permissionBasis = typeof body.permissionBasis === "string" ? body.permissionBasis.trim() : "";
  const expiresOn = body.expiresOn == null || body.expiresOn === "" ? null : String(body.expiresOn);
  if (!UUID.test(clientId) || !UUID.test(proofId) || !permissionBasis
    || permissionBasis.length > 2000
    || (expiresOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn))) {
    return json(400, { ok: false, error: "A client, proof, permission basis and valid expiry are required." });
  }
  let actorId: string;
  try {
    actorId = (await requireAdminOrClientManager(sb, req.headers.authorization, clientId)).userId;
  } catch (cause) {
    return json(cause instanceof AuthError ? cause.status : 401, {
      ok: false, error: cause instanceof AuthError ? cause.message : "Not permitted.",
    });
  }
  try {
    const first = await sb.rpc("proof_storage_identity_v6", { p_proof_id: proofId });
    if (first.error || !validIdentity(first.data, clientId, proofId)) {
      return json(409, { ok: false, error: "Could not verify this client's current proof file." });
    }
    const file = await sb.storage.from("proof").download(first.data.storage_path);
    if (file.error || !file.data) {
      return json(503, { ok: false, error: "Could not download the stored proof file." });
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
    if (bytes === 0) return json(409, { ok: false, error: "The proof file is empty." });
    const second = await sb.rpc("proof_storage_identity_v6", { p_proof_id: proofId });
    if (second.error || !validIdentity(second.data, clientId, proofId)
      || second.data.storage_path !== first.data.storage_path
      || second.data.object_id !== first.data.object_id
      || second.data.object_version !== first.data.object_version
      || second.data.object_updated_at !== first.data.object_updated_at) {
      return json(409, { ok: false, error: "The proof file changed during verification. Try again." });
    }
    const requested = await sb.rpc("request_proof_media_rights_v6", {
      p_proof_id: proofId, p_permission_basis: permissionBasis,
      p_expires_on: expiresOn, p_sha256: digest.digest("hex"), p_file_bytes: bytes,
      p_object_id: first.data.object_id,
      p_object_version: first.data.object_version,
      p_object_updated_at: first.data.object_updated_at,
      p_actor_id: actorId,
    });
    if (requested.error) return json(409, { ok: false, error: requested.error.message });
    return json(200, { ok: true, approvalRequestId: requested.data });
  } catch {
    return json(503, { ok: false, error: "Stored-file verification is unavailable." });
  }
}
