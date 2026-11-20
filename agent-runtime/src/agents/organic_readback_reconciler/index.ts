/** Revisit only acknowledged Meta IDs. This agent contains no publish transport. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { readMetaPublication, type PublicationReadback } from "../../publishing/readback.js";

interface DueReadback {
  post_id: string;
  client_id: string;
  platform: "instagram" | "facebook";
  frame_position: number;
  external_id: string;
  expected_account_ref: string;
}

type Read = (request: {
  platform: DueReadback["platform"]; accountId: string; accessToken: string;
}, externalId: string) => Promise<PublicationReadback>;

export async function runOrganicReadbackReconciliationJob(
  sb: SupabaseClient, _config: RuntimeConfig, _agent: AgentRow, job: AgentJobRow,
  _deadlineAt?: number, deps: { read?: Read } = {},
): Promise<JobResult> {
  const read = deps.read ?? readMetaPublication;
  let due = sb.from("organic_provider_readback_retry_due_v8")
    .select("post_id,client_id,platform,frame_position,external_id,expected_account_ref")
    .order("last_checked_at", { ascending: true, nullsFirst: true }).limit(5);
  if (job.client_id) due = due.eq("client_id", job.client_id);
  const { data, error } = await due;
  if (error) return { ok: false, retryable: true,
    failureMessage: `Could not list due provider reads: ${error.message}` };

  let verified = 0;
  let unavailable = 0;
  let mismatched = 0;
  let held = 0;
  for (const target of (data ?? []) as DueReadback[]) {
    const provider = target.platform === "instagram" ? "instagram" : "meta";
    const accountColumn = target.platform === "instagram" ? "credential_label" : "meta_page_id";
    const integration = await sb.from("client_integrations")
      .select("credential_label,meta_page_id,credential_secret_id,status")
      .eq("client_id", target.client_id).eq("provider", provider).maybeSingle();
    const row = integration.data as Record<string, unknown> | null;
    if (integration.error || !row?.credential_secret_id
      || !["connected", "active", "expiring"].includes(String(row.status))
      || row[accountColumn] !== target.expected_account_ref) {
      held++;
      continue;
    }
    const secret = await sb.rpc("integration_secret", {
      p_client_id: target.client_id, p_provider: provider,
    });
    if (secret.error || typeof secret.data !== "string" || !secret.data) {
      held++;
      continue;
    }
    const result = await read({ platform: target.platform,
      accountId: target.expected_account_ref, accessToken: secret.data }, target.external_id)
      .catch((): PublicationReadback => ({ status: "unavailable",
        observedAccountRef: null, providerUrl: null }));
    const recorded = await sb.rpc("record_organic_provider_readback_v8", {
      p_post_id: target.post_id,
      p_frame_position: target.frame_position,
      p_external_id: target.external_id,
      p_expected_account_ref: target.expected_account_ref,
      p_observed_account_ref: result.observedAccountRef,
      p_state: result.status,
      p_provider_url: result.providerUrl,
    });
    if (recorded.error) {
      // The read had no public effect. Retrying this job can only issue a GET.
      return { ok: false, retryable: true,
        failureMessage: `Could not record provider read-back: ${recorded.error.message}` };
    }
    if (result.status === "verified") verified++;
    else if (result.status === "mismatch") mismatched++;
    else unavailable++;
  }
  await appendEvent(sb, job.id,
    `Read-only provider reconciliation: ${verified} verified, ${unavailable} unavailable, ${mismatched} mismatched, ${held} held.`,
    mismatched || held ? "warn" : "info");
  return { ok: true, retryable: false };
}
