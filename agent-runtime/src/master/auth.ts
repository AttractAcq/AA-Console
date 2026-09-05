// Who is allowed to talk to the Master AI.
//
// The runtime authenticates with the service role key, which bypasses RLS
// completely. So this check is not one layer of defence among several — for
// anything the Master AI does, it is the only one. It fails closed.
//
// The caller's role is read from the database, never from the request. A
// JWT carries whatever claims it was minted with; profiles.role is the
// fact.

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../logging/logger.js";

export interface Caller {
  userId: string;
  email: string | null;
}

export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

function bearer(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) throw new AuthError("Missing Authorization header.");
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  const token = match?.[1]?.trim();
  if (!token) throw new AuthError("Authorization header must be a Bearer token.");
  return token;
}

/**
 * Verifies the caller's access token and that they are an admin.
 * Throws AuthError for anything less; never returns a partially-trusted
 * caller.
 */
export async function requireAdmin(
  sb: SupabaseClient,
  authorization: string | string[] | undefined,
): Promise<Caller> {
  const token = bearer(authorization);

  // Validates signature and expiry against the auth server.
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) {
    throw new AuthError("That session is not valid. Sign in again.");
  }
  const user = data.user;

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
