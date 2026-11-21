import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AuthError, requireAdminOrClientManager } from "../master/auth.js";
import { readJsonBody, UUID } from "../mcp/http.js";

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function requireOperatorAal2(
  sb: SupabaseClient,
  authorization: string | string[] | undefined,
  clientId: string,
): Promise<void> {
  const raw = Array.isArray(authorization) ? authorization[0] : authorization;
  const token = /^Bearer\s+([^\s]+)$/i.exec(raw ?? "")?.[1];
  if (!token) throw new AuthError("A signed-in session is required.");
  const [userResult, claimsResult] = await Promise.all([
    sb.auth.getUser(token), sb.auth.getClaims(token),
  ]);
  const user = userResult.data?.user;
  const claims = claimsResult.data?.claims;
  if (userResult.error || claimsResult.error || !user || !claims
    || claims.sub !== user.id || claims.role !== "authenticated"
    || claims.aal !== "aal2") {
    throw new AuthError("A current two-factor session is required.", 401);
  }
  const operator = await requireAdminOrClientManager(sb, authorization, clientId);
  if (operator.userId !== user.id) throw new AuthError("Operator identity changed.", 403);
}

function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Browser request for internal daily production only; no publication action. */
export async function handleDailyVideoOperator(
  req: IncomingMessage,
  res: ServerResponse,
  sb: SupabaseClient,
): Promise<void> {
  if (req.method !== "POST") {
    reply(res, 405, { ok: false, error: "POST only." });
    return;
  }
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req, 4096); }
  catch { reply(res, 400, { ok: false, error: "Invalid request body." }); return; }
  const clientId = body.clientId;
  if (typeof clientId !== "string" || !UUID.test(clientId)) {
    reply(res, 400, { ok: false, error: "Select a client." });
    return;
  }
  try {
    await requireOperatorAal2(sb, req.headers.authorization, clientId);
  } catch (error) {
    reply(res, error instanceof AuthError ? error.status : 503,
      { ok: false, error: error instanceof AuthError ? error.message : "Operator access could not be verified." });
    return;
  }
  if (body.action === "setup") {
    const campaignId = body.campaignId;
    const pillarId = body.pillarId;
    const platform = body.platform;
    const storyMediaType = body.storyMediaType;
    const cutoff = body.approvalCutoff;
    if (typeof campaignId !== "string" || !UUID.test(campaignId)
      || typeof pillarId !== "string" || !UUID.test(pillarId)
      || !["facebook", "instagram"].includes(String(platform))
      || !["image", "video"].includes(String(storyMediaType))
      || typeof cutoff !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(cutoff)) {
      reply(res, 400, { ok: false, error: "Choose a built campaign, active pillar, Meta destination, story format and cutoff." });
      return;
    }
    try {
      const { data, error } = await sb.rpc("configure_daily_package_settings_v1", {
        p_client_id: clientId, p_campaign_id: campaignId,
        p_pillar_id: pillarId, p_platform: platform as "facebook" | "instagram",
        p_story_media_type: storyMediaType as "image" | "video",
        p_approval_cutoff: cutoff,
      });
      if (error) { reply(res, 409, { ok: false, error: error.message }); return; }
      reply(res, 200, { ok: true, settings: data });
    } catch { reply(res, 503, { ok: false, error: "Daily package setup is unavailable." }); }
    return;
  }
  if (body.action === "configure") {
    const routeId = body.routePackageId;
    const ids = body.modelRecordIds;
    if (typeof routeId !== "string" || !UUID.test(routeId)
      || !Array.isArray(ids) || ids.length < 1 || ids.length > 12
      || ids.some((id) => typeof id !== "string" || !UUID.test(id))
      || new Set(ids).size !== ids.length) {
      reply(res, 400, { ok: false, error: "Choose a current organic route and 1–12 distinct reviewed sources." });
      return;
    }
    try {
      const { data, error } = await sb.rpc("configure_daily_video_sources_v1", {
        p_client_id: clientId, p_route_package_id: routeId,
        p_record_ids: ids as string[],
      });
      if (error) { reply(res, 409, { ok: false, error: error.message }); return; }
      reply(res, 200, { ok: true, configured: data });
    } catch { reply(res, 503, { ok: false, error: "Daily video configuration is unavailable." }); }
    return;
  }
  if (body.action === "plan") {
    if (!validDay(body.packageDay)) {
      reply(res, 400, { ok: false, error: "Choose a valid package day." });
      return;
    }
    try {
      const { data, error } = await sb.rpc("plan_daily_code_video_package_v1", {
        p_client_id: clientId, p_day: body.packageDay,
      });
      if (error) { reply(res, 409, { ok: false, error: error.message }); return; }
      const packageRow = data as { id?: string; run_id?: string; package_day?: string } | null;
      if (!packageRow || !UUID.test(packageRow.id ?? "")
        || !UUID.test(packageRow.run_id ?? "")) {
        reply(res, 503, { ok: false, error: "Daily package read-back was incomplete." });
        return;
      }
      reply(res, 200, { ok: true, packageId: packageRow.id,
        runId: packageRow.run_id, packageDay: packageRow.package_day });
    } catch { reply(res, 503, { ok: false, error: "Daily package planning is unavailable." }); }
    return;
  }
  reply(res, 400, { ok: false, error: "Unknown daily video action." });
}
