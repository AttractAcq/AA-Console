// GET /admin/github/status — is publishing going to work?
//
// Admin-authenticated, same as the Master AI route, because the answer names
// the organisation AA publishes through and the permissions it holds. Not a
// secret, but not for every logged-in user either.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import { AuthError, requireAdmin } from "../master/auth.js";
import { readGitHubStatus } from "./status.js";
import { logger } from "../logging/logger.js";

export async function handleGitHubStatus(
  req: IncomingMessage,
  res: ServerResponse,
  sb: SupabaseClient,
  config: RuntimeConfig,
): Promise<void> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  try {
    await requireAdmin(sb, req.headers.authorization);
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 401;
    json(status, { ok: false, error: "Not permitted." });
    return;
  }

  try {
    const status = await readGitHubStatus({
      appId: config.githubAppId ?? undefined,
      privateKey: config.githubAppPrivateKey ?? undefined,
      installationId: config.githubInstallationId,
    });
    json(200, { ok: true, ...status });
  } catch (err) {
    // Never echo the error upward — it could carry request detail. The log
    // keeps it; the browser gets a sentence.
    logger.error("github_status_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    json(200, { ok: true, configured: false, missing: [], ready: false, error: "Could not check GitHub." });
  }
}
