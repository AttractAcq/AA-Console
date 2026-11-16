// Who is allowed to talk to the Master AI, and who may hold a hard-hold.
//
// The runtime authenticates with the service role key, which bypasses RLS
// completely. So this check is not one layer of defence among several — for
// anything the Master AI does, it is the only one. It fails closed.
//
// The caller's role is read from the database, never from the request. A
// JWT carries whatever claims it was minted with; profiles.role is the
// fact. Bot identity is the opposite pair: the verified JWT's app_metadata
// (is_bot or bot_key) is enough on its own, and profiles.is_bot is checked
// as well so a stale claim cannot outrun the row. Migration 324 mirrors
// the row into raw_app_meta_data. Until that column exists, a missing
// is_bot is logged and the claim alone is used.

import type { SupabaseClient, User } from "@supabase/supabase-js";
import { logger } from "../logging/logger.js";

export const BOT_FORBIDDEN_CODE = "bot_forbidden";

export interface Caller {
  userId: string;
  email: string | null;
  /** Present when the gate has decided this caller is not a bot. */
  isBot?: boolean;
}

export class AuthError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status = 401, code: string | null = null) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

export function botForbidden(): AuthError {
  return new AuthError(BOT_FORBIDDEN_CODE, 403, BOT_FORBIDDEN_CODE);
}

export function isBotForbidden(err: unknown): err is AuthError {
  return err instanceof AuthError && err.code === BOT_FORBIDDEN_CODE;
}

/** True when the verified access token's app_metadata marks a console bot. */
export function claimIsBot(appMetadata: User["app_metadata"] | null | undefined): boolean {
  if (!appMetadata || typeof appMetadata !== "object") return false;
  if (appMetadata.is_bot === true) return true;
  const key = appMetadata.bot_key;
  return typeof key === "string" && key.trim().length > 0;
}

function bearer(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) throw new AuthError("Missing Authorization header.");
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  const token = match?.[1]?.trim();
  if (!token) throw new AuthError("Authorization header must be a Bearer token.");
  return token;
}

function isMissingIsBotColumn(error: { code?: string; message?: string; details?: string }): boolean {
  const code = String(error.code ?? "");
  const blob = `${code} ${error.message ?? ""} ${error.details ?? ""}`.toLowerCase();
  if (!blob.includes("is_bot")) return false;
  return (
    code === "42703" ||
    code === "PGRST204" ||
    blob.includes("does not exist") ||
    blob.includes("could not find") ||
    blob.includes("schema cache")
  );
}

type ProfileIdentity = { role: string | null; isBot: boolean };

/**
 * role and is_bot from profiles. A missing is_bot column (migration 324
 * not applied yet) is logged and treated as not-a-bot so the claim can
 * still be checked. Any other lookup error fails closed.
 */
async function readProfile(sb: SupabaseClient, userId: string): Promise<ProfileIdentity> {
  const first = await sb.from("profiles").select("role, is_bot").eq("id", userId).maybeSingle();
  if (!first.error) {
    const row = first.data as { role?: string | null; is_bot?: boolean | null } | null;
    return { role: row?.role ?? null, isBot: row?.is_bot === true };
  }
  if (isMissingIsBotColumn(first.error)) {
    logger.warn("bot_identity_column_missing", { userId, error: first.error.message });
    const second = await sb.from("profiles").select("role").eq("id", userId).maybeSingle();
    if (second.error) {
      logger.error("human_admin_role_lookup_failed", { userId, error: second.error.message });
      throw new AuthError("Could not verify your role.", 503);
    }
    const row = second.data as { role?: string | null } | null;
    return { role: row?.role ?? null, isBot: false };
  }
  logger.error("human_admin_role_lookup_failed", { userId, error: first.error.message });
  throw new AuthError("Could not verify your role.", 503);
}

async function verifiedUser(
  sb: SupabaseClient,
  authorization: string | string[] | undefined,
): Promise<User> {
  const token = bearer(authorization);
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) {
    throw new AuthError("That session is not valid. Sign in again.");
  }
  return data.user;
}

function assertNotBot(user: User, profile: ProfileIdentity): void {
  if (claimIsBot(user.app_metadata) || profile.isBot) {
    logger.warn("bot_forbidden", { userId: user.id });
    throw botForbidden();
  }
}

/**
 * Verifies the caller's access token and that they are an admin.
 * Does not apply the bot hold. Hard-hold routes use requireHumanAdmin.
 * Throws AuthError for anything less; never returns a partially-trusted
 * caller.
 */
export async function requireAdmin(
  sb: SupabaseClient,
  authorization: string | string[] | undefined,
): Promise<Caller> {
  const user = await verifiedUser(sb, authorization);

  const { data: profile, error: profileError } = await sb
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    // Do not fall through to a permissive path on an infrastructure error.
    logger.error("master_ai_role_lookup_failed", { userId: user.id, error: profileError.message });
    throw new AuthError("Could not verify your role.", 503);
  }
  if (!profile || profile.role !== "admin") {
    logger.warn("master_ai_forbidden", { userId: user.id, role: profile?.role ?? null });
    throw new AuthError("The Master AI is available to admins only.", 403);
  }

  return { userId: user.id, email: user.email ?? null };
}

/**
 * Admin, and not a bot. The hold for routes that grant service_role write
 * power or a hard-hold (publish, credentials, invitations, spend, sites).
 * Fails closed when the profile cannot be read. A missing is_bot column
 * falls back to the verified JWT claim and does not crash.
 */
export async function requireHumanAdmin(
  sb: SupabaseClient,
  authorization: string | string[] | undefined,
): Promise<Caller> {
  const user = await verifiedUser(sb, authorization);
  const profile = await readProfile(sb, user.id);
  if (profile.role !== "admin") {
    logger.warn("human_admin_forbidden", { userId: user.id, role: profile.role });
    throw new AuthError("This action is available to admins only.", 403);
  }
  assertNotBot(user, profile);
  return { userId: user.id, email: user.email ?? null, isBot: false };
}

/**
 * Refuses a bot session without requiring an admin role. Invitation inspect
 * is the invitee's route, and a bot is still not allowed to open it.
 * Fails closed on a profile lookup error. A missing is_bot column falls
 * back to the claim.
 */
export async function refuseBot(
  sb: SupabaseClient,
  authorization: string | string[] | undefined,
): Promise<void> {
  const user = await verifiedUser(sb, authorization);
  const profile = await readProfile(sb, user.id);
  assertNotBot(user, profile);
}

/**
 * Verifies the caller and that they may act for this client: an admin, or
 * the manager actually assigned to it. A bot is refused either way.
 *
 * The same pair every v6 database function gates on — `is_admin()` or
 * `active_video_approval_manager(client_id)` — so that a route cannot be a
 * softer door into something the SQL would have refused. The assignment is
 * read through the same function the policies use rather than re-derived
 * here, because two expressions of "who manages this client" is one too
 * many.
 */
export async function requireAdminOrClientManager(
  sb: SupabaseClient,
  authorization: string | string[] | undefined,
  clientId: string,
): Promise<Caller> {
  const user = await verifiedUser(sb, authorization);

  let profile: ProfileIdentity;
  let manager: unknown;
  let managerError: { message?: string } | null;
  try {
    const [profileRow, managerResult] = await Promise.all([
      readProfile(sb, user.id),
      sb.rpc("active_video_approval_manager", { p_client_id: clientId }),
    ]);
    profile = profileRow;
    manager = managerResult.data;
    managerError = managerResult.error;
  } catch (err) {
    if (err instanceof AuthError) throw err;
    logger.error("client_authority_lookup_failed", {
      userId: user.id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new AuthError("Could not verify your role.", 503);
  }

  if (managerError) {
    // Never fall through to a permissive path on an infrastructure error.
    logger.error("client_authority_lookup_failed", {
      userId: user.id,
      error: managerError.message,
    });
    throw new AuthError("Could not verify your role.", 503);
  }
  if (profile.role !== "admin" && manager !== user.id) {
    logger.warn("client_action_forbidden", { userId: user.id, clientId });
    throw new AuthError("Only an admin or this client's assigned manager can do that.", 403);
  }
  assertNotBot(user, profile);

  return { userId: user.id, email: user.email ?? null, isBot: false };
}
