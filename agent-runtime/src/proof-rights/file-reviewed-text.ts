import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AuthError, requireAdminOrClientManager } from "../master/auth.js";
import { UUID, readJsonBody } from "../mcp/http.js";
import { PRIVATE_OBJECT_CACHE_CONTROL_SECONDS } from "../storage/signed-url-policy.js";

export async function handleFileReviewedText(req: IncomingMessage, res: ServerResponse, sb: SupabaseClient) {
  const reply = (status: number, body: Record<string, unknown>) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST") return reply(405, { error: "POST only." });
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch { return reply(400, { error: "Expected a JSON body." }); }
  const { clientId, requestId, briefId, rightsId, revision } = body;
  if (![clientId, requestId, briefId, rightsId].every(v => typeof v === "string" && UUID.test(v))
    || typeof revision !== "string" || !Number.isFinite(Date.parse(revision))) {
    return reply(400, { error: "Select a saved proof request and reviewed brief version." });
  }
  try {
    const actor = await requireAdminOrClientManager(sb, req.headers.authorization, String(clientId));
    const args = { p_client_id: clientId, p_request_id: requestId, p_brief_id: briefId,
      p_revision: revision, p_actor_id: actor.userId, p_rights_id: rightsId };
    const inspect = () => sb.rpc("file_reviewed_proof_text", args);
    let state = await inspect();
    if (state.error || !state.data) return reply(409, { error: "Refresh and check the source clearance, exact Script and existing deliveries." });
    if (state.data.asset_id === requestId) return reply(200, { ok: true, assetId: requestId });
    const { path, script } = state.data;
    const bytes = Buffer.from(script, "utf8");
    const bucket = sb.storage.from("client-media");
    if (!state.data.object) {
      const upload = await bucket.upload(path, bytes, {
        upsert: false, contentType: "text/plain; charset=utf-8", cacheControl: PRIVATE_OBJECT_CACHE_CONTROL_SECONDS,
      });
      // A concurrent or interrupted filing may already own this immutable path.
      state = await inspect();
      if (!state.error && state.data?.asset_id === requestId) return reply(200, { ok: true, assetId: requestId });
      if (state.error || state.data?.path !== path || state.data?.script !== script || !state.data.object) {
        return reply(upload.error ? 503 : 409, { error: "Could not verify the private file against the reviewed version. Refresh before retrying." });
      }
    }
    const file = await bucket.download(path);
    if (file.error || !file.data || file.data.size !== bytes.length ||
        !Buffer.from(await file.data.arrayBuffer()).equals(bytes)) {
      return reply(409, { error: "The stored bytes do not match the cleared source." });
    }
    const filed = await sb.rpc("file_reviewed_proof_text", { ...args, p_verified_object: state.data.object });
    if (filed.error || filed.data?.asset_id !== requestId) {
      return reply(409, { error: "The source, brief or stored file changed. Refresh before retrying." });
    }
    return reply(200, { ok: true, assetId: requestId });
  } catch (err) {
    return reply(err instanceof AuthError ? err.status : 503, {
      error: err instanceof AuthError ? err.message : "Exact text filing is unavailable.",
    });
  }
}
