// Metrics ingest runner.
//
// The one runner in this codebase with no model in it. Pulling a number
// from an API into a column has exactly one correct answer, and clients see
// these numbers, so the whole job is: fetch, normalise, upsert, idempotently.
//
// Idempotence is the point rather than a nicety. Meta's figures for a given
// day keep moving for about a week as attribution windows close, so the
// schedule re-pulls a trailing window every day and overwrites. Every write
// goes through metrics_daily_identity.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { metaGraphSource } from "./graph.js";
import { normaliseOrganicAccount, normaliseOrganicPosts, normalisePaid } from "./normalise.js";
import { SourceError, type MetricRow, type MetricsSource, type Surface, type Window } from "./types.js";

const UPSERT_CHUNK = 500;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultWindow(days = 7): Window {
  const until = new Date();
  const since = new Date(until.getTime() - days * 86_400_000);
  return { since: since.toISOString().slice(0, 10), until: until.toISOString().slice(0, 10) };
}

function readParams(job: AgentJobRow): { surface: Surface; window: Window } {
  const params = (job.params ?? {}) as Record<string, unknown>;
  const surface = String(params.surface ?? "paid") as Surface;
  const fallback = defaultWindow();
  return {
    surface,
    window: {
      since: typeof params.since === "string" ? params.since : fallback.since,
      until: typeof params.until === "string" ? params.until : fallback.until,
    },
  };
}

/**
 * Same API and same token model, different account: Ads Insights is
 * addressed by act_<id> and Instagram insights by the IG user id, and
 * credential_label holds one id. So each surface reads its own row.
 */
const PROVIDER_FOR_SURFACE: Record<string, string> = {
  paid: "meta",
  organic: "instagram",
};

/** The credential label carries the account id; the Vault secret is the token. */
async function loadCredentials(sb: SupabaseClient, clientId: string, surface: Surface) {
  const provider = PROVIDER_FOR_SURFACE[surface];
  if (!provider) return null;

  const { data: integration, error } = await sb
    .from("client_integrations")
    .select("credential_label, status")
    .eq("client_id", clientId)
    .eq("provider", provider)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw new Error(`Could not read the integration: ${error.message}`);
  if (!integration) return null;

  const { data: token, error: secretError } = await sb.rpc("integration_secret", {
    p_client_id: clientId,
    p_provider: provider,
  });
  if (secretError) throw new Error(`Could not read the credential: ${secretError.message}`);
  if (!token || !integration.credential_label) return null;

  return {
    provider,
    accessToken: String(token),
    accountId: String(integration.credential_label),
  };
}

/** Attaches our own campaign/post ids where the external id is one we know. */
async function attachLocalIds(
  sb: SupabaseClient,
  clientId: string,
  rows: MetricRow[],
): Promise<Array<MetricRow & { client_id: string; campaign_id: string | null; post_id: string | null }>> {
  const campaignIds = rows.filter((r) => r.entity_type === "campaign").map((r) => r.external_id);
  const postIds = rows.filter((r) => r.entity_type === "post").map((r) => r.external_id);

  const [campaigns, posts] = await Promise.all([
    campaignIds.length
      ? sb.from("campaigns").select("id, external_id").eq("client_id", clientId).in("external_id", [...new Set(campaignIds)])
      : Promise.resolve({ data: [] as Array<{ id: string; external_id: string | null }> }),
    postIds.length
      ? sb.from("scheduled_posts").select("id, external_id").eq("client_id", clientId).in("external_id", [...new Set(postIds)])
      : Promise.resolve({ data: [] as Array<{ id: string; external_id: string | null }> }),
  ]);

  const campaignBy = new Map(
    (campaigns.data ?? []).filter((c) => c.external_id).map((c) => [c.external_id as string, c.id]),
  );
  const postBy = new Map(
    (posts.data ?? []).filter((p) => p.external_id).map((p) => [p.external_id as string, p.id]),
  );

  return rows.map((row) => ({
    ...row,
    client_id: clientId,
    // Unmapped is normal and not an error: it means numbers exist for
    // something that was never created in the console.
    campaign_id: row.entity_type === "campaign" ? campaignBy.get(row.external_id) ?? null : null,
    post_id: row.entity_type === "post" ? postBy.get(row.external_id) ?? null : null,
  }));
}

export function normaliseFor(surface: Surface, payload: unknown[], window: Window): MetricRow[] {
  if (surface === "paid") return normalisePaid(payload, window);

  if (surface === "organic") {
    const out: MetricRow[] = [];
    for (const part of payload) {
      const tagged = part as { __kind?: string; rows?: unknown[] };
      if (tagged?.__kind === "media") out.push(...normaliseOrganicPosts(tagged.rows ?? [], today()));
      else if (tagged?.__kind === "account") {
        // The account id is stamped by the caller; a placeholder here would
        // collide across clients on the unique key.
        out.push(...normaliseOrganicAccount(tagged.rows ?? [], "__account__", window));
      }
    }
    return out;
  }

  return [];
}

export async function runMetricsIngestJob(
  sb: SupabaseClient,
  _config: RuntimeConfig,
  _agent: AgentRow,
  job: AgentJobRow,
  // This agent calls no model, so it has no loop to cut short — it is bounded
  // by the lease alone. The parameter is here to satisfy JobRunner's shape.
  _deadlineAt?: number,
  source: MetricsSource = metaGraphSource,
): Promise<JobResult> {
  if (!job.client_id) {
    return { ok: false, retryable: false, failureMessage: "Metrics ingest needs a client." };
  }

  const { surface, window } = readParams(job);

  const credentials = await loadCredentials(sb, job.client_id, surface);
  if (!credentials) {
    return {
      ok: false,
      retryable: false,
      failureMessage:
        `This client has no active ${PROVIDER_FOR_SURFACE[surface] ?? surface} integration. ` +
        "Connect one in Account → Integrations, then re-run.",
    };
  }

  await appendEvent(
    sb,
    job.id,
    `Pulling ${surface} metrics for ${window.since} to ${window.until} from ${source.name}.`,
  );

  let payload: unknown[];
  try {
    payload = await source.fetch(surface, window, credentials);
  } catch (error) {
    if (error instanceof SourceError) {
      // A dead credential is worth recording on the integration itself, so
      // the Account page can show it rather than leaving it buried in a job.
      if (!error.retryable) {
        await sb
          .from("client_integrations")
          .update({ status: "error", last_checked_at: new Date().toISOString() })
          .eq("client_id", job.client_id)
          .eq("provider", credentials.provider);
      }
      return { ok: false, retryable: error.retryable, failureMessage: error.message };
    }
    throw error;
  }

  const rows = normaliseFor(surface, payload, window).map((row) =>
    row.external_id === "__account__" ? { ...row, external_id: credentials.accountId } : row,
  );

  if (rows.length === 0) {
    await appendEvent(sb, job.id, "Nothing came back for that window.");
    await sb
      .from("client_integrations")
      .update({ status: "active", last_checked_at: new Date().toISOString() })
      .eq("client_id", job.client_id)
      .eq("provider", credentials.provider);
    return { ok: true, retryable: false };
  }

  const prepared = await attachLocalIds(sb, job.client_id, rows);

  let written = 0;
  for (let i = 0; i < prepared.length; i += UPSERT_CHUNK) {
    const chunk = prepared.slice(i, i + UPSERT_CHUNK);
    const { error } = await sb.from("metrics_daily").upsert(chunk, {
      onConflict: "client_id,surface,entity_type,external_id,metric_date",
    });
    if (error) throw new Error(`Failed to write metrics: ${error.message}`);
    written += chunk.length;
  }

  const mapped = prepared.filter((r) => r.campaign_id || r.post_id).length;
  await sb
    .from("client_integrations")
    .update({ status: "active", last_checked_at: new Date().toISOString() })
    .eq("client_id", job.client_id)
    .eq("provider", credentials.provider);

  await appendEvent(
    sb,
    job.id,
    `Wrote ${written} ${surface} row(s); ${mapped} attached to a campaign or post.`,
  );
  return { ok: true, retryable: false };
}
