import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import { AuthError, requireAdmin } from "../master/auth.js";
import { collectSystemReadiness } from "./collect.js";
import { logger } from "../logging/logger.js";

/** Admin-only inventory. A failure in one source is recorded as unknown/error;
 * it never silently converts into a healthy status or a secret-bearing log. */
export async function handleSystemReadiness(
  req: IncomingMessage,
  res: ServerResponse,
  sb: SupabaseClient,
  config: RuntimeConfig,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "GET") {
    json(405, { ok: false, error: "GET only" });
    return;
  }
  try {
    await requireAdmin(sb, req.headers.authorization);
  } catch (error) {
    json(error instanceof AuthError ? error.status : 401, { ok: false, error: "Not permitted." });
    return;
  }
  try {
    json(200, { ok: true, ...await collectSystemReadiness(sb, config) });
  } catch (error) {
    logger.error("system_readiness_failed", { error: error instanceof Error ? error.name : "unknown" });
    json(503, { ok: false, error: "The system inventory could not be collected." });
  }
}
