import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { MetaAdsReadError, readMetaAdsAccount } from "../../meta/read-only.js";

function windowDates(now: Date) {
  const through = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(through.getTime() - 29 * 86_400_000);
  return { from: from.toISOString().slice(0, 10), through: through.toISOString().slice(0, 10) };
}

/** Reads one current, granted Meta ad account; this worker has no write transport. */
export async function runMetaAdsReadJob(sb: SupabaseClient, _config: RuntimeConfig,
  _agent: AgentRow, job: AgentJobRow): Promise<JobResult> {
  if (!job.client_id) return { ok: false, retryable: false, failureMessage: "Meta Ads read needs a client." };
  const integration = await sb.from("client_integrations")
    .select("id,ad_account_id,credential_secret_id")
    .eq("client_id", job.client_id).eq("provider", "meta").maybeSingle();
  if (integration.error || !integration.data?.ad_account_id || !integration.data.credential_secret_id)
    return { ok: false, retryable: false,
      failureMessage: "A single configured Meta ad account is required in Integrations." };
  const secret = await sb.rpc("integration_secret", {
    p_client_id: job.client_id, p_provider: "meta",
  });
  if (secret.error || !secret.data) return { ok: false, retryable: false,
    failureMessage: "Meta credential or read grant is not currently usable." };
  const window = windowDates(new Date());
  try {
    const read = await readMetaAdsAccount({
      accountId: integration.data.ad_account_id, accessToken: String(secret.data),
    }, window.from, window.through);
    const recorded = await sb.rpc("record_meta_ads_read_v7", {
      p_client_id: job.client_id, p_integration_id: integration.data.id,
      p_credential_secret_id: integration.data.credential_secret_id, p_job_id: job.id,
      p_account_id: read.accountId, p_currency: read.currency,
      p_from_date: read.fromDate, p_through_date: read.throughDate,
      p_campaigns: read.campaigns, p_ads: read.ads,
    });
    if (recorded.error) throw new Error(`Could not record Meta Ads read: ${recorded.error.message}`);
    await appendEvent(sb, job.id,
      `Read ${read.campaigns.length} Meta campaigns and ${read.ads.length} ads for ${read.accountId}; ${window.from} to ${window.through}.`);
    return { ok: true, retryable: false };
  } catch (cause) {
    if (cause instanceof MetaAdsReadError) return {
      ok: false, retryable: cause.retryable, failureMessage: cause.message,
    };
    throw cause;
  }
}
