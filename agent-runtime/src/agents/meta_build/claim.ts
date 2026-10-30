import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentJobRow } from "../../queue.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MetaCampaignIdentity {
  id: string;
  client_id: string;
  acquisition_mode: string | null;
  paid_platform: string | null;
}

/**
 * A v6 build must belong to the one execution that queued this exact job.
 * Migration 289 defines the producer for this contract, but it remains held.
 * Until its atomic SQL binding is released, an approved v6 request still
 * cannot reach Meta.
 */
export async function v6MetaBuildClaimProblem(
  sb: SupabaseClient,
  job: AgentJobRow,
  campaign: MetaCampaignIdentity,
): Promise<string | null> {
  if (campaign.acquisition_mode !== "paid" || campaign.paid_platform !== "meta") {
    return "Only a paid Meta campaign can use the v6 Meta build approval.";
  }

  const executionId = job.params?.campaign_action_execution_id;
  const approvalId = job.params?.campaign_action_approval_id;
  if (typeof executionId !== "string" || !UUID.test(executionId)
      || typeof approvalId !== "string" || !UUID.test(approvalId)) {
    return "The Meta build job has no exact campaign action execution and approval binding.";
  }

  const { data: execution, error: executionError } = await sb
    .from("campaign_action_executions")
    .select("id, approval_id, client_id, campaign_id, action_key, artifact_version_hash, manifest_id, status, lease_until, meta_build_job_id")
    .eq("id", executionId)
    .maybeSingle();
  if (executionError) return `Could not verify the Meta build execution: ${executionError.message}`;
  if (!execution || execution.approval_id !== approvalId
      || execution.client_id !== job.client_id || execution.client_id !== campaign.client_id
      || execution.campaign_id !== campaign.id || execution.action_key !== "meta_ad_build"
      || execution.status !== "executing"
      || typeof execution.lease_until !== "string"
      || !Number.isFinite(Date.parse(execution.lease_until))
      || Date.parse(execution.lease_until) <= Date.now()
      || execution.meta_build_job_id !== job.id) {
    return "The Meta build job is not bound to a current, claimed execution for this campaign.";
  }

  const { data: approval, error: approvalError } = await sb
    .from("campaign_action_approvals")
    .select("id, client_id, campaign_id, manifest_id, action_key, artifact_version_hash, status, destination, scope")
    .eq("id", approvalId)
    .maybeSingle();
  if (approvalError) return `Could not verify the Meta build approval: ${approvalError.message}`;
  if (!approval || approval.client_id !== campaign.client_id
      || approval.campaign_id !== campaign.id || approval.action_key !== "meta_ad_build"
      || approval.status !== "approved"
      || approval.manifest_id !== execution.manifest_id
      || approval.artifact_version_hash !== execution.artifact_version_hash) {
    return "The Meta build execution does not match an approved version of this campaign.";
  }

  // Read only the destination identity before any credential is loaded.
  const { data: integration, error: integrationError } = await sb
    .from("client_integrations")
    .select("ad_account_id")
    .eq("client_id", campaign.client_id)
    .eq("provider", "meta")
    .maybeSingle();
  if (integrationError) return `Could not verify the Meta build destination: ${integrationError.message}`;
  const accountId = integration?.ad_account_id;
  const scope = approval.scope;
  if (typeof accountId !== "string" || !accountId.trim()
      || approval.destination !== `meta:${accountId}`
      || !scope || typeof scope !== "object" || Array.isArray(scope)
      || scope.ad_account !== accountId) {
    return "The Meta account is not the exact destination in the approved build.";
  }

  // Migration 239 rechecks the live package/hash/switch and returns the
  // latest valid approval. Never accept its answer for a different claim.
  const { data: allowedApprovalId, error: gateError } = await sb.rpc("assert_meta_build_allowed_v6", {
    p_campaign_id: campaign.id,
  } as never);
  if (gateError) return gateError.message;
  if (allowedApprovalId !== approvalId) {
    return "The current Meta build approval is not the one claimed by this job.";
  }
  return null;
}
