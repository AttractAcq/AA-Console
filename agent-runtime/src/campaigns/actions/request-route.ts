// POST /admin/campaign-actions/request
//
// Asks for the human decision that migration 230's executor waits on.
//
// WHY THIS IS A ROUTE AND NOT AN RPC THE BROWSER CALLS
//
// `request_campaign_action_approval_v6` is service-role only, and migration
// 206 is explicit about why: a request has to be built from the real package
// and the real artifact hashes, not from whatever a client sends. If the
// browser could write the request, the exact-version guarantee would rest on
// the browser being honest about which version it meant.
//
// So the shape is: a person presses a button, this route authenticates them
// against the same pair of gates the SQL uses, and the database builds the
// request from the rows. The person's identity is passed through so that the
// placement approvals record who asked, rather than recording "the system".
//
// This route creates a pending request. It performs no external action and
// approves nothing.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";

import { AuthError, requireAdminOrClientManager } from "../../master/auth.js";
import { readJsonBody, UUID } from "../../mcp/http.js";
import { logger } from "../../logging/logger.js";

/** The actions a person can ask for from here, and how to build each one. */
const ASKABLE = new Set(["proof_publish"]);

export async function handleCampaignActionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sb: SupabaseClient,
): Promise<void> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  if (req.method !== "POST") {
    json(405, { ok: false, error: "POST only" });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    json(400, { ok: false, error: "Expected a JSON body." });
    return;
  }

  const clientId = String(body.clientId ?? "");
  const campaignId = String(body.campaignId ?? "");
  const actionKey = String(body.actionKey ?? "");
  if (!UUID.test(clientId) || !UUID.test(campaignId)) {
    json(400, { ok: false, error: "A client and a campaign are required." });
    return;
  }
  if (!ASKABLE.has(actionKey)) {
    json(400, {
      ok: false,
      error: `There is nothing to ask for called "${actionKey}". Only proof publication can be requested here so far.`,
    });
    return;
  }

  let userId: string;
  try {
    ({ userId } = await requireAdminOrClientManager(sb, req.headers.authorization, clientId));
  } catch (err) {
    json(err instanceof AuthError ? err.status : 401, {
      ok: false,
      error: err instanceof AuthError ? err.message : "Not permitted.",
    });
    return;
  }

  // The campaign has to belong to the client the caller was authorised for.
  // Without this, authority over one client would be authority over any
  // campaign id somebody could guess.
  const { data: campaign, error: campaignError } = await sb
    .from("client_campaigns")
    .select("id, client_id")
    .eq("id", campaignId)
    .maybeSingle();
  if (campaignError) {
    json(503, { ok: false, error: "Could not read that campaign." });
    return;
  }
  if (!campaign || (campaign as { client_id: string }).client_id !== clientId) {
    json(404, { ok: false, error: "That campaign does not belong to this client." });
    return;
  }

  const { data, error } = await sb.rpc("request_campaign_proof_publish_v6", {
    p_campaign_id: campaignId,
    p_actor: userId,
  } as never);
  if (error) {
    // The database's own sentence, which is written to be read by whoever
    // pressed the button: "this campaign has no package yet", "approve the
    // source and claim of every artifact first".
    json(400, { ok: false, error: error.message });
    return;
  }

  logger.info("campaign_action_requested", {
    clientId,
    campaignId,
    actionKey,
    approvalId: String(data ?? ""),
    requestedBy: userId,
  });
  json(200, { ok: true, approvalId: data });
}
