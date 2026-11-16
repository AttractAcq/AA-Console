import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { GoogleAdsReadError, readGoogleAdsAccount } from "../../google-ads/read-only.js";

function windowDates(now: Date): { from: string; through: string } {
  const through = new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()));
  const from = new Date(through.getTime()-29*86_400_000);
  return { from: from.toISOString().slice(0,10), through: through.toISOString().slice(0,10) };
}

/** Reads one exact Google Ads customer; no build or spend endpoint is called. */
export async function runGoogleAdsReadJob(
  sb: SupabaseClient, config: RuntimeConfig, _agent: AgentRow, job: AgentJobRow,
): Promise<JobResult> {
  if (!job.client_id) return { ok:false,retryable:false,failureMessage:"Google Ads read needs a client." };
  if (!config.googleAdsDeveloperToken) return { ok:false,retryable:false,
    failureMessage:"Google Ads developer token is not configured for read-only reporting." };
  const integration = await sb.from("client_integrations")
    .select("id,google_ads_customer_id,credential_secret_id")
    .eq("client_id",job.client_id).eq("provider","google_ads").maybeSingle();
  if (integration.error || !integration.data?.google_ads_customer_id
    || !integration.data.credential_secret_id) return {
    ok:false,retryable:false,
    failureMessage:"A single configured Google Ads customer is required in Integrations.",
  };
  const secret = await sb.rpc("integration_secret", {
    p_client_id:job.client_id,p_provider:"google_ads",
  });
  if (secret.error || !secret.data) return { ok:false,retryable:false,
    failureMessage:"Google Ads credential or read grant is not currently usable." };
  const window = windowDates(new Date());
  try {
    const read = await readGoogleAdsAccount({
      customerId:integration.data.google_ads_customer_id,
      accessToken:String(secret.data),
      developerToken:config.googleAdsDeveloperToken,
      loginCustomerId:config.googleAdsLoginCustomerId,
    },window.from,window.through);
    const recorded = await sb.rpc("record_google_ads_read_v7", {
      p_client_id:job.client_id,p_integration_id:integration.data.id,
      p_credential_secret_id:integration.data.credential_secret_id,p_job_id:job.id,
      p_customer_id:read.customerId,p_currency:read.currency,
      p_from_date:window.from,p_through_date:window.through,
      p_request_id:read.requestId,p_campaigns:read.campaigns,
    });
    if (recorded.error) throw new Error(`Could not record Google Ads read: ${recorded.error.message}`);
    await appendEvent(sb,job.id,
      `Read ${read.campaigns.length} Google Ads campaigns for customer ${read.customerId}; ${window.from} to ${window.through}.`);
    return { ok:true,retryable:false };
  } catch (cause) {
    if (cause instanceof GoogleAdsReadError) return {
      ok:false,retryable:cause.retryable,failureMessage:cause.message,
    };
    throw cause;
  }
}
