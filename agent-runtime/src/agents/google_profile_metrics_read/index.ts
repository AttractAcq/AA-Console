/** One exact-location, read-only Business Profile performance job. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { ProfilePerformanceReadError, readProfilePerformance } from "../../google-profile/performance-read.js";

function windowDates(now: Date): { from: string; through: string } {
  const through = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    - 86_400_000);
  const from = new Date(through.getTime() - 29 * 86_400_000);
  return { from: from.toISOString().slice(0, 10), through: through.toISOString().slice(0, 10) };
}

export async function runGoogleProfileMetricsReadJob(
  sb: SupabaseClient, _config: RuntimeConfig, _agent: AgentRow, job: AgentJobRow,
): Promise<JobResult> {
  if (job.input_table !== "client_google_locations" || !job.input_id || !job.client_id) {
    return { ok: false, retryable: false,
      failureMessage: "Business Profile read needs an exact location and client." };
  }
  const [location, integration] = await Promise.all([
    sb.from("client_google_locations").select("id,client_id,location_ref,verification_state")
      .eq("id", job.input_id).eq("client_id", job.client_id).maybeSingle(),
    sb.from("client_integrations")
      .select("id,status,credential_secret_id,token_expires_at")
      .eq("client_id", job.client_id).eq("provider", "google_business").maybeSingle(),
  ]);
  if (location.error || integration.error || !location.data || !integration.data
    || location.data.verification_state !== "verified"
    || !["active", "connected"].includes(integration.data.status)
    || !integration.data.credential_secret_id
    || (integration.data.token_expires_at
      && Date.parse(integration.data.token_expires_at) <= Date.now())) {
    return { ok: false, retryable: false,
      failureMessage: "Verified Business Profile location and current integration are required." };
  }
  const secret = await sb.rpc("integration_secret", {
    p_client_id: job.client_id, p_provider: "google_business",
  });
  if (secret.error || !secret.data) return { ok: false, retryable: false,
    failureMessage: "Business Profile credential is unavailable." };
  const dates = windowDates(new Date());
  try {
    const read = await readProfilePerformance({
      locationRef: location.data.location_ref,
      accessToken: String(secret.data), from: dates.from, through: dates.through,
    });
    const recorded = await sb.rpc("record_google_profile_performance_read_v8", {
      p_client_id: job.client_id,
      p_location_id: location.data.id,
      p_integration_id: integration.data.id,
      p_credential_secret_id: integration.data.credential_secret_id,
      p_job_id: job.id,
      p_location_ref: read.locationRef,
      p_from_date: read.from,
      p_through_date: read.through,
      p_observed_metrics: read.observedMetrics,
      p_points: read.points,
    } as never);
    if (recorded.error) return { ok: false, retryable: false,
      failureMessage: "Provider data was read but its current-account snapshot was not recorded." };
    await appendEvent(sb, job.id,
      `Business Profile performance read: ${read.observedMetrics.length} metric series, ${read.points.length} dated values; no profile write.`)
      .catch(() => undefined);
    return { ok: true, retryable: false };
  } catch (cause) {
    if (cause instanceof ProfilePerformanceReadError) return {
      ok: false, retryable: cause.retryable, failureMessage: cause.message,
    };
    throw cause;
  }
}
