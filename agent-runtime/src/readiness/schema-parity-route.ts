import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import { AuthError, requireAdmin } from "../master/auth.js";
import { logger } from "../logging/logger.js";
import { collectSchemaParity, schemaParityConfig } from "./schema-parity-live.js";

let cached: { report: Awaited<ReturnType<typeof collectSchemaParity>>; at: number } | null = null;
let pending: Promise<Awaited<ReturnType<typeof collectSchemaParity>>> | null = null;

async function latest(config: RuntimeConfig) {
  const now = Date.now();
  if (cached && now - cached.at < 60_000) return cached.report;
  if (pending) return pending;
  pending = collectSchemaParity(config);
  try {
    const report = await pending;
    cached = { report, at: Date.now() };
    return report;
  } finally { pending = null; }
}

/** The only live parity endpoint. It accepts an admin JWT, never a project ref,
 * SQL string or Management API credential from the browser. */
export async function handleSchemaParity(
  req: IncomingMessage, res: ServerResponse, sb: SupabaseClient, config: RuntimeConfig,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "GET") { json(405, { ok: false, error: "GET only" }); return; }
  try { await requireAdmin(sb, req.headers.authorization); }
  catch (error) {
    json(error instanceof AuthError ? error.status : 401, { ok: false, error: "Not permitted." });
    return;
  }
  if (!schemaParityConfig(config)) {
    json(503, { ok: false, error: "Schema parity read access is not configured." });
    return;
  }
  try { json(200, { ok: true, ...await latest(config) }); }
  catch (error) {
    logger.error("schema_parity_read_failed", { error: error instanceof Error ? error.name : "unknown" });
    json(503, { ok: false, error: "The live schema parity audit could not be collected." });
  }
}
