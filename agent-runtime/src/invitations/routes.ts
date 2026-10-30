import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import { AuthError, requireAdmin } from "../master/auth.js";
import { readJsonBody, UUID } from "../mcp/http.js";

type InvitationRow = {
  id: string;
  idempotency_key: string;
  recipient_email: string;
  target_role: "employee" | "client";
  target_member_id: string | null;
  target_client_id: string | null;
  full_name: string;
  team_category: string | null;
  sender_account: string;
  redirect_origin: string;
  requested_by: string;
  payload_hash: string;
  payload: Record<string, unknown>;
  expires_at: string;
  status: string;
  provider_user_id: string | null;
};

const HASH = /^[0-9a-f]{64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function bearer(authorization: string | string[] | undefined): string {
  const raw = Array.isArray(authorization) ? authorization[0] : authorization;
  const token = /^Bearer\s+([^\s]+)$/i.exec(raw ?? "")?.[1];
  if (!token) throw new AuthError("A signed-in session is required.");
  return token;
}

async function verifiedSession(
  sb: SupabaseClient,
  authorization: string | string[] | undefined,
  aal2: boolean,
): Promise<{ id: string; email: string }> {
  const token = bearer(authorization);
  const [userResult, claimsResult] = await Promise.all([
    sb.auth.getUser(token), sb.auth.getClaims(token),
  ]);
  const user = userResult.data?.user;
  const claims = claimsResult.data?.claims;
  if (userResult.error || claimsResult.error || !user || !claims
    || claims.sub !== user.id || claims.role !== "authenticated"
    || (aal2 && claims.aal !== "aal2")) {
    throw new AuthError(aal2
      ? "A current two-factor session is required."
      : "That invitation session is not valid.", 401);
  }
  if (!user.email || !EMAIL.test(user.email)) {
    throw new AuthError("The signed-in Auth account has no usable email.", 403);
  }
  return { id: user.id, email: user.email.toLowerCase() };
}

async function adminAal2(
  sb: SupabaseClient,
  authorization: string | string[] | undefined,
): Promise<{ id: string; email: string }> {
  const verified = await verifiedSession(sb, authorization, true);
  const admin = await requireAdmin(sb, authorization);
  if (admin.userId !== verified.id) throw new AuthError("Admin identity changed.", 403);
  return verified;
}

function configuredSender(config: RuntimeConfig): { sender: string; origin: string } {
  const sender = config.authInviteSenderEmail?.trim().toLowerCase();
  let url: URL;
  try { url = new URL(config.consoleUrl); }
  catch { throw new AuthError("Invitation redirect is not configured.", 503); }
  if (!sender || !EMAIL.test(sender) || url.protocol !== "https:"
    || url.origin !== config.consoleUrl || url.username || url.password) {
    throw new AuthError("Auth invitation sender or console origin is not configured.", 503);
  }
  return { sender, origin: url.origin };
}

type SenderReadback = {
  sender: string; origin: string; projectOrigin: string; verificationId: string;
};

async function verifiedSender(sb: SupabaseClient, config: RuntimeConfig): Promise<SenderReadback> {
  const configured = configuredSender(config);
  let projectOrigin: string;
  try {
    const url = new URL(config.supabaseUrl);
    if (url.protocol !== "https:") throw new Error("not HTTPS");
    projectOrigin = url.origin;
  } catch { throw new AuthError("Supabase Auth project origin is not configured.", 503); }
  const { data, error } = await sb.from("console_auth_sender_verifications_v6")
    .select("id,verified_at,expires_at,template_subject,template_body,template_sha256,evidence_sha256")
    .eq("sender_email", configured.sender)
    .eq("supabase_url_origin", projectOrigin)
    .eq("redirect_origin", configured.origin)
    .gt("expires_at", new Date().toISOString())
    .order("verified_at", { ascending: false }).limit(1).maybeSingle();
  if (error || !data) {
    throw new AuthError("Auth SMTP sender and redirect need a current verified read-back.", 503);
  }
  if (!UUID.test(data.id) || !HASH.test(data.template_sha256)
    || !HASH.test(data.evidence_sha256)
    || typeof data.template_subject !== "string" || !data.template_subject.trim()
    || typeof data.template_body !== "string" || !data.template_body.trim()) {
    throw new AuthError("Auth sender and template read-back evidence is incomplete.", 503);
  }
  return { ...configured, projectOrigin, verificationId: data.id };
}

/** Auth Admin API is the primary existing-email check; errors fail closed. */
export async function existingAuthEmail(sb: SupabaseClient, email: string): Promise<boolean> {
  const perPage = 200;
  for (let page = 1; page <= 100; page += 1) {
    let result: Awaited<ReturnType<typeof sb.auth.admin.listUsers>>;
    try { result = await sb.auth.admin.listUsers({ page, perPage }); }
    catch { throw new AuthError("Could not verify existing Auth accounts.", 503); }
    const { data, error } = result;
    if (error || !data?.users) throw new AuthError("Could not verify existing Auth accounts.", 503);
    if (data.users.some((user) => user.email?.toLowerCase() === email)) return true;
    if (data.users.length < perPage) return false;
  }
  throw new AuthError("Auth account lookup exceeded its safe limit.", 503);
}

async function findRequest(sb: SupabaseClient, id: string): Promise<InvitationRow | null> {
  const { data, error } = await sb.from("console_invitation_requests_v6")
    .select("*").eq("id", id).maybeSingle();
  if (error) throw new AuthError("Could not read the invitation.", 503);
  return data as InvitationRow | null;
}

function safeError(error: unknown): { status: number; message: string } {
  if (error instanceof AuthError) return { status: error.status, message: error.message };
  return { status: 503, message: "The invitation could not be completed. Check its state before retrying." };
}

export async function handleInvitationRequest(
  req: IncomingMessage, res: ServerResponse, sb: SupabaseClient,
  config: RuntimeConfig,
): Promise<void> {
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
  try {
    const admin = await adminAal2(sb, req.headers.authorization);
    const { sender, origin, projectOrigin, verificationId } = await verifiedSender(sb, config);
    const body = await readJsonBody(req);
    const email = String(body.email ?? "").trim().toLowerCase();
    const targetRole = String(body.targetRole ?? "");
    const memberId = body.memberId == null ? null : String(body.memberId);
    const clientId = body.clientId == null ? null : String(body.clientId);
    const key = String(body.idempotencyKey ?? "");
    if (!EMAIL.test(email) || email.length > 320 || !UUID.test(key)
      || !((targetRole === "employee" && memberId && UUID.test(memberId) && !clientId)
        || (targetRole === "client" && clientId && UUID.test(clientId) && !memberId))) {
      return json(res, 400, { ok: false, error: "One recipient and one valid roster or client target are required." });
    }

    const { data: prior, error: priorError } = await sb
      .from("console_invitation_requests_v6").select("*")
      .eq("idempotency_key", key).maybeSingle();
    if (priorError) throw new AuthError("Could not check the invitation key.", 503);
    if (prior) {
      const row = prior as InvitationRow;
      if (row.recipient_email !== email || row.target_role !== targetRole
        || row.target_member_id !== memberId || row.target_client_id !== clientId
        || row.sender_account !== sender || row.redirect_origin !== origin
        || row.payload.auth_project_origin !== projectOrigin
        || row.payload.sender_verification_id !== verificationId
        || row.requested_by !== admin.id) {
        return json(res, 409, { ok: false, error: "That invitation key belongs to a different request." });
      }
      return json(res, 200, { ok: true, requestId: row.id, status: row.status });
    }
    if (await existingAuthEmail(sb, email)) {
      return json(res, 409, { ok: false,
        error: "An Auth account already uses that email, including if unverified. Review its provenance before linking access." });
    }
    const { data, error } = await sb.rpc("request_console_invitation_v6", {
      p_recipient_email: email, p_target_role: targetRole,
      p_target_member_id: memberId, p_target_client_id: clientId,
      p_sender_account: sender, p_redirect_origin: origin,
      p_auth_project_origin: projectOrigin, p_verification_id: verificationId,
      p_idempotency_key: key, p_actor_id: admin.id,
    } as never);
    if (error) return json(res, 409, { ok: false,
      error: "Invitation request conflicts with current account or roster state. Refresh and review before retrying." });
    return json(res, 200, { ok: true, requestId: data, status: "requested" });
  } catch (error) {
    const safe = safeError(error);
    return json(res, safe.status, { ok: false, error: safe.message });
  }
}

/** Intentionally inert until an exact-version provider-controlled mail path exists. */
export async function sendApprovedInvitation(
  _sb: SupabaseClient, _config: RuntimeConfig, _requestId: string,
  _actorId: string, _expectedHash: string,
): Promise<{ status: string }> {
  throw new AuthError(
    "Invitation sending is disabled until the provider-controlled exact-email path is released.",
    503,
  );
}

export async function handleInvitationSend(
  req: IncomingMessage, res: ServerResponse, sb: SupabaseClient,
  config: RuntimeConfig,
): Promise<void> {
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
  try {
    const admin = await adminAal2(sb, req.headers.authorization);
    const body = await readJsonBody(req);
    const result = await sendApprovedInvitation(sb, config,
      String(body.requestId ?? ""), admin.id, String(body.expectedHash ?? ""));
    return json(res, 200, { ok: true, ...result });
  } catch (error) {
    const safe = safeError(error);
    return json(res, safe.status, { ok: false, error: safe.message });
  }
}

export async function handleInvitationAccept(
  req: IncomingMessage, res: ServerResponse, sb: SupabaseClient,
): Promise<void> {
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
  try {
    const user = await verifiedSession(sb, req.headers.authorization, false);
    const body = await readJsonBody(req);
    const requestId = String(body.requestId ?? "");
    if (!UUID.test(requestId)) return json(res, 400, { ok: false, error: "Invalid invitation link." });
    const { data, error } = await sb.rpc("accept_console_invitation_v6", {
      p_request_id: requestId, p_auth_user_id: user.id, p_auth_email: user.email,
    } as never);
    if (error) return json(res, 409, { ok: false,
      error: "This invitation cannot be accepted by the current Auth account or is no longer active." });
    const row = data as InvitationRow;
    return json(res, 200, { ok: true, status: row.status, role: row.target_role });
  } catch (error) {
    const safe = safeError(error);
    return json(res, safe.status, { ok: false, error: safe.message });
  }
}

export async function handleInvitationList(
  req: IncomingMessage, res: ServerResponse, sb: SupabaseClient,
): Promise<void> {
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
  try {
    await requireAdmin(sb, req.headers.authorization);
    const { data, error } = await sb.from("console_invitation_requests_v6")
      .select("id,target_member_id,recipient_email,status,expires_at,payload_hash")
      .order("requested_at", { ascending: false }).limit(500);
    if (error) throw new AuthError("Could not load invitation states.", 503);
    const now = Date.now();
    const invitations = (data ?? []).map((row) => ({ ...row,
      status: ["requested", "approved", "sent"].includes(row.status)
        && Date.parse(row.expires_at) <= now ? "expired" : row.status,
    }));
    return json(res, 200, { ok: true, invitations });
  } catch (error) {
    const safe = safeError(error);
    return json(res, safe.status, { ok: false, error: safe.message });
  }
}

export async function handleInvitationInspect(
  req: IncomingMessage, res: ServerResponse, sb: SupabaseClient,
): Promise<void> {
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
  try {
    const user = await verifiedSession(sb, req.headers.authorization, false);
    const body = await readJsonBody(req);
    const requestId = String(body.requestId ?? "");
    if (!UUID.test(requestId)) return json(res, 400, { ok: false, error: "Invalid invitation link." });
    const row = await findRequest(sb, requestId);
    if (!row || row.provider_user_id !== user.id || row.recipient_email !== user.email
      || !["sent", "accepted"].includes(row.status)
      || (row.status === "sent" && new Date(row.expires_at).getTime() <= Date.now())) {
      return json(res, 404, { ok: false, error: "No active invitation for this Auth account." });
    }
    return json(res, 200, { ok: true, invitation: {
      recipientEmail: row.recipient_email,
      targetRole: row.target_role,
      fullName: row.full_name,
      teamCategory: row.team_category,
      status: row.status,
    } });
  } catch (error) {
    const safe = safeError(error);
    return json(res, safe.status, { ok: false, error: safe.message });
  }
}
