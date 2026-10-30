/**
 * Does this client's token still work?
 *
 * Runs daily for Meta and Instagram integrations whose status still permits
 * a guarded credential read. A debug_token response can warn about expiry or
 * demote a bad token. It cannot verify account ownership and required scopes,
 * so it must never reactivate a terminal status on its own.
 *
 * One client's bad token must not stop the others being checked, so each
 * integration is handled on its own and its failure is recorded rather than
 * raised.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { logger } from "../../logging/logger.js";
import { readTokenHealth, statusToWrite, type TokenVerdict } from "./health.js";

const GRAPH_VERSION = "v21.0";
const BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const TIMEOUT_MS = 30_000;
const META_PROVIDERS = new Set(["meta", "instagram"]);
const TERMINAL_STATUSES = new Set(["error", "expired", "revoked"]);
const CHECKABLE_STATUSES = new Set(["connected", "active", "expiring"]);

export interface IntegrationRow {
  id: string;
  client_id: string;
  provider: string;
  status: string;
  credential_secret_id: string | null;
  token_expires_at: string | null;
}

/**
 * Ask Meta about a token.
 *
 * debug_token needs two tokens: the one being inspected and one to
 * authenticate the request. Using the same token for both is what Meta's own
 * docs do for a first-party app, and it means a revoked token fails the
 * request rather than reporting on itself.
 */
export async function debugToken(token: string): Promise<unknown> {
  const url = `${BASE}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      // Only Meta's explicit OAuth-token error is evidence of revocation.
      // Rate limits, app faults, and transport failures must not change an
      // otherwise usable integration to error.
      const error = (body as { error?: { message?: unknown } } | null)?.error;
      if (response.status === 400 && Number((error as { code?: unknown } | undefined)?.code) === 190) {
        return { data: { is_valid: false, error } };
      }
      throw new Error(`Meta debug_token returned HTTP ${response.status}.`);
    }
    return body ?? {};
  } finally {
    clearTimeout(timer);
  }
}

export async function runTokenHealthJob(
  sb: SupabaseClient,
  _runtime: RuntimeConfig,
  agent: AgentRow,
  job: AgentJobRow,
  _deadlineAt: number,
  deps: { check?: (token: string) => Promise<unknown>; now?: () => number } = {},
): Promise<JobResult> {
  const check = deps.check ?? debugToken;
  const now = deps.now ?? Date.now;

  // Include rows without credentials when checking client/provider ambiguity:
  // integration_secret sees all rows, not just credentialed ones.
  let query = sb
    .from("client_integrations")
    .select("id, client_id, provider, status, credential_secret_id, token_expires_at");
  if (job.client_id) query = query.eq("client_id", job.client_id);

  const { data, error } = await query;
  if (error) {
    return { ok: false, retryable: true, failureMessage: `Could not list integrations: ${error.message}` };
  }

  const integrations = (data ?? []) as IntegrationRow[];
  if (integrations.length === 0) {
    await appendEvent(sb, job.id, "No integrations are configured to check.");
    return { ok: true, retryable: false };
  }

  let checked = 0;
  let broken = 0;
  let warned = 0;
  let skipped = 0;
  const trouble: string[] = [];
  const keyOf = (integration: IntegrationRow) => JSON.stringify([integration.client_id, integration.provider]);
  const rowCountByKey = new Map<string, number>();
  for (const integration of integrations) {
    const key = keyOf(integration);
    rowCountByKey.set(key, (rowCountByKey.get(key) ?? 0) + 1);
  }

  for (const integration of integrations) {
    try {
      // integration_secret is keyed by client/provider, while this worker
      // writes a specific row. Refuse an ambiguous pair rather than applying
      // one row's token verdict to another row.
      if ((rowCountByKey.get(keyOf(integration)) ?? 0) !== 1) {
        skipped += 1;
        trouble.push(`${integration.provider}: duplicate integration rows require review`);
        continue;
      }
      if (integration.credential_secret_id === null) {
        skipped += 1;
        continue;
      }
      if (!META_PROVIDERS.has(integration.provider)) {
        skipped += 1;
        continue;
      }
      if (TERMINAL_STATUSES.has(integration.status)) {
        skipped += 1;
        trouble.push(`${integration.provider}: ${integration.status} requires a new credential or guarded review`);
        continue;
      }
      if (!CHECKABLE_STATUSES.has(integration.status)) {
        skipped += 1;
        trouble.push(`${integration.provider}: unknown status ${integration.status} requires review`);
        continue;
      }

      const { data: token, error: secretError } = await sb.rpc("integration_secret", {
        p_client_id: integration.client_id,
        p_provider: integration.provider,
      } as never);

      if (secretError) {
        skipped += 1;
        trouble.push(`${integration.provider}: credential read failed; status preserved`);
        continue;
      }

      let verdict: TokenVerdict;
      if (typeof token !== "string" || token.trim().length === 0) {
        // Released SQL refuses expiring credentials, and migration 291 will
        // refuse one after its known expiry. Null is not proof of revocation.
        if (integration.status === "expiring") {
          skipped += 1;
          trouble.push(`${integration.provider}: expiring credential was not readable; status preserved`);
          continue;
        }
        verdict = {
          status: "error",
          detail: "No usable credential is stored for this integration.",
          expiresAt: null,
          usable: false,
        };
      } else {
        verdict = readTokenHealth(await check(String(token)), now());
      }

      const next = statusToWrite(integration.status, verdict);
      const { data: applied, error: writeError } = await sb
        .from("client_integrations")
        .update({
          status: next,
          last_checked_at: new Date(now()).toISOString(),
          token_expires_at: verdict.expiresAt ?? integration.token_expires_at,
          health_detail: verdict.detail,
        })
        .eq("id", integration.id)
        .eq("client_id", integration.client_id)
        .eq("provider", integration.provider)
        .eq("status", integration.status)
        .eq("credential_secret_id", integration.credential_secret_id)
        .select("id");
      if (writeError) throw new Error(writeError.message);
      if (!Array.isArray(applied) || applied.length !== 1) {
        skipped += 1;
        trouble.push(`${integration.provider}: integration changed during the check; stale verdict discarded`);
        continue;
      }
      checked += 1;
      if (next === "error") broken += 1;
      if (verdict.status === "expiring") warned += 1;
      if (next === "error" || verdict.status === "expiring") {
        trouble.push(`${integration.provider}: ${verdict.detail}`);
      }
    } catch (caught) {
      // One client's trouble is not the others'.
      skipped += 1;
      const message = caught instanceof Error ? caught.message : String(caught);
      trouble.push(`${integration.provider}: could not be checked (${message})`);
      logger.warn("token_health_check_failed", { jobId: job.id, provider: integration.provider, message });
    }
  }

  const summary =
    `Checked ${checked} integration${checked === 1 ? "" : "s"}: ` +
    `${broken} not working, ${warned} expiring soon, ${skipped} skipped` +
    ".";

  await appendEvent(sb, job.id, summary, trouble.length > 0 ? "warn" : "info", {
    checked,
    broken,
    warned,
    skipped,
    trouble,
  });
  logger.info("token_health", { jobId: job.id, checked, broken, warned, skipped });

  void agent;
  return { ok: true, retryable: false };
}
