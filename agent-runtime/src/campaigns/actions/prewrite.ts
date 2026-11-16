import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../../config.js";
import { deployedCommitSha } from "../../readiness/version.js";
import type { ClaimedAction } from "./executor.js";

/** An external action failure and whether its outcome is safe to retry. */
export class ActionError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean = false,
    readonly outcomeUncertain: boolean = false,
    readonly externalId: string | null = null,
    readonly externalUrl: string | null = null,
    readonly result: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "ActionError";
  }
}

export function ownedIdentity(config: RuntimeConfig): { workerId: string; buildSha: string } {
  const workerId = config.campaignActionWorkerId;
  const buildSha = deployedCommitSha();
  if (!config.campaignActionsEnabled || !config.campaignActionOwnedClaimEnabled
    || !workerId || !buildSha) {
    throw new ActionError("The campaign action worker is not attested for a prewrite check.");
  }
  return { workerId, buildSha };
}

/** Refuse an outward effect if its exact approval or worker attestation changed after claim. */
export async function assertActionPrewrite(
  sb: SupabaseClient, config: RuntimeConfig, action: ClaimedAction,
): Promise<void> {
  const { workerId, buildSha } = ownedIdentity(config);
  const { error } = await sb.rpc("assert_campaign_action_prewrite_v6", {
    p_execution_id: action.execution_id,
    p_worker_id: workerId,
    p_build_sha: buildSha,
    p_action_key: action.action_key,
  } as never);
  if (error) throw new ActionError(`Campaign action prewrite refused: ${error.message}`);
}
