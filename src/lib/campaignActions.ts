import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "./supabase";
import { callRuntime } from "./callRuntime";

/**
 * Campaign actions, from the browser's side.
 *
 * Migration 206 records the human decision about one exact campaign package,
 * action, destination and artifact version. Migration 230 records what was
 * then done about it. This file reads the second one, because an approval
 * nobody can see the outcome of is the same problem as no approval at all:
 * somebody clicks yes and then has to guess.
 *
 * Asking goes through the runtime rather than straight to the database.
 * `request_campaign_action_approval_v6` is service-role only by design --
 * the request has to be built from the real package and the real hashes
 * rather than from whatever a browser sends -- so the button posts to a
 * route that authenticates the person and lets the database assemble it.
 */

/**
 * The tables migrations 230 and 231 add are not in the generated types yet.
 * `src/types/database.ts` is regenerated from the database once a migration
 * has been applied, which happens after this change is reviewed, so reading
 * them goes through one deliberately untyped client in one file rather than
 * by hand-editing the generated one. That file was partly hand-written
 * fiction once and the cure was to stop writing it by hand.
 *
 * Every shape below is declared explicitly, so what this code expects is
 * still written down; the regeneration replaces the cast, not the types.
 */
const untyped = supabase as unknown as SupabaseClient;

/** One approved action, and why it has or has not happened. */
export interface CampaignActionDue {
  approval_id: string;
  client_id: string;
  campaign_id: string;
  action_key: string;
  destination: string;
  artifact_version_hash: string;
  execution_id: string | null;
  execution_status: string;
  attempts: number;
  external_id: string | null;
  external_url: string | null;
  last_error: string | null;
  executor_module: string;
  blocker: string | null;
}

/** What each execution status means where a person reads it. */
export const EXECUTION_HINT: Record<string, string> = {
  not_attempted: "Approved. Nothing has tried to perform it yet.",
  executing: "Being performed now.",
  executed: "Done, and the external result is on the record.",
  failed: "The last attempt failed and will be tried again.",
  abandoned: "Stopped after a failure that cannot be safely retried.",
};

export async function fetchCampaignActionDue(clientId: string): Promise<CampaignActionDue[]> {
  const { data, error } = await untyped
    .from("campaign_action_due")
    .select(
      "approval_id, client_id, campaign_id, action_key, destination, artifact_version_hash, execution_id, execution_status, attempts, external_id, external_url, last_error, executor_module, blocker",
    )
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  return (data ?? []) as CampaignActionDue[];
}

/** Whether this client's approved actions may be performed at all. */
export async function fetchCampaignActionsEnabled(clientId: string): Promise<boolean> {
  const { data, error } = await untyped
    .from("client_engine_settings")
    .select("campaign_actions_enabled")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean((data as { campaign_actions_enabled?: boolean } | null)?.campaign_actions_enabled);
}

export async function setCampaignActionsEnabled(clientId: string, enabled: boolean): Promise<void> {
  const { error } = await untyped.rpc("set_campaign_actions_enabled", {
    p_client_id: clientId,
    p_enabled: enabled,
  });
  if (error) throw new Error(error.message);
}

/**
 * Ask for one campaign-level decision covering this campaign's drafted proof
 * placements. Creates a pending request; it publishes nothing and approves
 * nothing.
 */
export async function requestProofPublish(clientId: string, campaignId: string): Promise<string> {
  const result = await callRuntime<{ approvalId: string }>("/admin/campaign-actions/request", {
    clientId,
    campaignId,
    actionKey: "proof_publish",
  });
  return result.approvalId;
}
