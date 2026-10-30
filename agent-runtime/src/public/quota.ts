import type { IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import { logger } from "../logging/logger.js";
import { resolveCallerIp } from "./client-ip.js";

export type PublicRoute = "lead_submit" | "proof_config" | "proof_submit" | "sales_message" | "booking_submit";
export type Admission = { allowed: true; ipHash: string } | { allowed: false; reason: "invalid_peer" | "quota" | "store_error" };

export function saltedPublicHash(value: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${value}`).digest("hex");
}

export function publicSubjectHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** One database transaction atomically admits both the caller and subject buckets. */
export async function admitPublicRequest(
  req: IncomingMessage,
  sb: SupabaseClient,
  config: RuntimeConfig,
  route: PublicRoute,
  subject: string,
): Promise<Admission> {
  const ip = resolveCallerIp(req, config.trustedProxies);
  if (!ip) {
    logger.info("public_request_refused", { route, reason: "invalid_peer" });
    return { allowed: false, reason: "invalid_peer" };
  }
  const ipHash = saltedPublicHash(ip, config.publicIpSalt);
  try {
    const { data, error } = await sb.rpc("admit_public_route_v6", {
      p_route: route,
      p_ip_hash: ipHash,
      p_subject_hash: publicSubjectHash(subject),
    } as never);
    if (error) throw error;
    if (data !== true) {
      logger.info("public_request_refused", { route, reason: "quota" });
      return { allowed: false, reason: "quota" };
    }
    return { allowed: true, ipHash };
  } catch {
    logger.warn("public_request_refused", { route, reason: "store_error" });
    return { allowed: false, reason: "store_error" };
  }
}
