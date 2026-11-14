// Verify the stored file from the trusted runtime before a human can approve
// its exact version. The browser supplies IDs only, never a hash or byte count.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";

import { AuthError, requireAdminOrClientManager } from "../master/auth.js";
import { readJsonBody, UUID } from "../mcp/http.js";

export async function handleLeadMagnetAttestation(
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
  const approvalId = String(body.approvalId ?? "");
  if (!UUID.test(clientId) || !UUID.test(approvalId)) {
    return json(400, { ok: false, error: "A client and approval are required." });
  }
  try { await requireAdminOrClientManager(sb, req.headers.authorization, clientId); }
  catch (cause) {
    return json(cause instanceof AuthError ? cause.status : 401, {
      ok: false, error: cause instanceof AuthError ? cause.message : "Not permitted.",
    });
  }
  const approval = await sb.from("lead_magnet_approvals")
    .select("id,client_id,magnet_version_id,status,inbox_enforced_v6")
    .eq("id", approvalId).eq("client_id", clientId).maybeSingle();
  if (approval.error) return json(503, { ok: false, error: "Could not read the approval." });
  if (!approval.data || approval.data.client_id !== clientId) {
    return json(404, { ok: false, error: "That approval does not belong to this client." });
  }
  if (approval.data.status !== "pending" || !approval.data.inbox_enforced_v6) {
    return json(409, { ok: false, error: "This new approval is no longer awaiting verification." });
  }
  const version = await sb.from("lead_magnet_versions")
    .select("id,client_id,storage_path,content_sha256,file_bytes")
    .eq("id", approval.data.magnet_version_id).eq("client_id", clientId).maybeSingle();
  if (version.error || !version.data || version.data.client_id !== clientId) {
    return json(503, { ok: false, error: "Could not read the exact magnet version." });
  }
  try {
    const file = await sb.storage.from("client-media").download(version.data.storage_path);
    if (file.error || !file.data) {
      return json(503, { ok: false, error: "Could not download the stored file." });
    }
    const bytes = Buffer.from(await file.data.arrayBuffer());
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== version.data.content_sha256 || bytes.length !== version.data.file_bytes) {
      return json(409, { ok: false, error: "Stored bytes differ from the version under review." });
    }
    const attestation = await sb.rpc("attest_lead_magnet_bytes_v6", {
      p_approval_id: approvalId, p_sha256: sha256, p_file_bytes: bytes.length,
    } as never);
    if (attestation.error) return json(409, { ok: false, error: attestation.error.message });
    return json(200, { ok: true, approvalRequestId: attestation.data });
  } catch {
    return json(503, { ok: false, error: "Stored-file verification is unavailable." });
  }
}
