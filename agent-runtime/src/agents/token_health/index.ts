/**
 * Does this client's token still work?
 *
 * M1.2. Runs daily over every integration that has a credential, asks Meta's
 * debug_token, and writes back one of four states. It is the only thing in
 * the system that can move an integration *out* of `error` without a person
 * pasting a token again.
 *
 * That gap was not theoretical. On 6 October an Instagram integration failed
 * on a deprecated metric name, the agent correctly marked it `error`, the
 * metric name was fixed and deployed twenty minutes later — and the
 * integration stayed excluded from the scheduler, because nothing could say
 * the token had been fine the whole time. Ingestion would have stayed off
 * until somebody noticed and re-entered a credential that was never wrong.
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

export interface IntegrationRow {
  id: string;
  client_id: string;
  provider: string;
  status: string;
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
      // A 400 here is Meta's answer, not a transport fault: the token is bad.
      // Shaped so readTokenHealth reaches the same verdict either way.
      const error = (body as { error?: { message?: unknown } } | null)?.error;
      return { data: { is_valid: false, error: error ?? { message: `Meta returned ${response.status}.` } } };
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

  // Every integration with a credential, including ones already in error —
  // those are the ones most worth asking about.
  let query = sb
    .from("client_integrations")
    .select("id, client_id, provider, status")
    .not("credential_secret_id", "is", null);
  if (job.client_id) query = query.eq("client_id", job.client_id);

  const { data, error } = await query;
  if (error) {
    return { ok: false, retryable: true, failureMessage: `Could not list integrations: ${error.message}` };
  }

  const integrations = (data ?? []) as IntegrationRow[];
  if (integrations.length === 0) {
    await appendEvent(sb, job.id, "No integrations have a credential to check.");
    return { ok: true, retryable: false };
  }

  let checked = 0;
  let rescued = 0;
  let broken = 0;
  let warned = 0;
  const trouble: string[] = [];

  for (const integration of integrations) {
    try {
      const { data: token, error: secretError } = await sb.rpc("integration_secret", {
        p_client_id: integration.client_id,
        p_provider: integration.provider,
      } as never);

      let verdict: TokenVerdict;
      if (secretError || !token) {
        // No readable secret is itself an answer: there is nothing to use.
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
      checked += 1;
      if (next === "error") broken += 1;
      else if (next === "expiring") warned += 1;
      if (integration.status === "error" && next !== "error") rescued += 1;
      if (next !== "connected" && next !== "active") {
        trouble.push(`${integration.provider}: ${verdict.detail}`);
      }

      const { error: writeError } = await sb
        .from("client_integrations")
        .update({
          status: next,
          last_checked_at: new Date(now()).toISOString(),
          token_expires_at: verdict.expiresAt,
          health_detail: verdict.detail,
        })
        .eq("id", integration.id);
      if (writeError) throw new Error(writeError.message);
    } catch (caught) {
      // One client's trouble is not the others'.
      const message = caught instanceof Error ? caught.message : String(caught);
      trouble.push(`${integration.provider}: could not be checked (${message})`);
      logger.warn("token_health_check_failed", { jobId: job.id, provider: integration.provider, message });
    }
  }

  const summary =
    `Checked ${checked} integration${checked === 1 ? "" : "s"}: ` +
    `${broken} not working, ${warned} expiring soon` +
    (rescued > 0 ? `, ${rescued} recovered` : "") +
    ".";

  await appendEvent(sb, job.id, summary, trouble.length > 0 ? "warn" : "info", {
    checked,
    broken,
    warned,
    rescued,
    trouble,
  });
  logger.info("token_health", { jobId: job.id, checked, broken, warned, rescued });

  void agent;
  return { ok: true, retryable: false };
}
