/**
 * The campaign action executor.
 *
 * Migration 206 gave a person a way to say yes to one exact campaign
 * package, one action, one destination and one artifact version. Migration
 * 230 gave that yes a lifecycle. Migration 325 adds the atomic owned claim.
 *
 * OFF IS A STATE, NOT AN ERROR
 *
 * With CAMPAIGN_ACTIONS_ENABLED unset this does nothing and says so,
 * successfully. Not a dry run that pretends: a dry run reporting success
 * would have the database record an execution that never happened, which is
 * a lie told in the one place a person checks before asking why the client's
 * ads are not live.
 *
 * CLAIM HOLD
 *
 * The owned path remains opt-in. A fresh heartbeat, complete deployed build
 * SHA and matching registered handler set are checked in the SQL claim. The
 * runtime records each attempt's actual outcome, including failures.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { deployCampaignPage } from "./page-deploy.js";
import { changeAdSetBudget } from "./budget-change.js";
import { GENERIC_CAMPAIGN_ACTION_CLAIM_HOLD } from "./preclaim-hold.js";
import { ACTION_HANDLER_MODULES } from "./handler-ownership.js";
import { deployedCommitSha } from "../../readiness/version.js";

export interface ClaimedAction {
  execution_id: string;
  approval_id: string;
  client_id: string;
  campaign_id: string;
  manifest_id: string;
  action_key: string;
  destination: string;
  artifact_version_hash: string;
  scope: Record<string, unknown> | null;
  attempt: number;
}

/** What an executor produced. Nothing it did not. */
export interface ActionOutcome {
  /** The destination's own id for whatever was created, where there is one. */
  readonly externalId?: string | null;
  readonly externalUrl?: string | null;
  /** Anything worth putting on the record. Never a credential. */
  readonly result?: Record<string, unknown> | null;
  readonly detail?: string;
}

/**
 * A failure that says whether trying again could plausibly work.
 *
 * Default false, everywhere, deliberately. The actions behind this gate
 * create ad objects and deploy pages; an unknown error retried three times
 * is three chances to do one of those twice.
 */
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

export type ActionHandler = (
  sb: SupabaseClient,
  config: RuntimeConfig,
  action: ClaimedAction,
) => Promise<ActionOutcome>;

/** SQL rejections roll back their transaction; a lost RPC response does not tell us. */
function internalRpcFailure(error: { message: string; code?: string }, action: string): ActionError {
  const code = error.code ?? "";
  const retryable = code === "40001" || code === "40P01";
  const rolledBack = retryable || /^(22|23|28|42|P0)[0-9A-Z]{3}$/.test(code);
  return new ActionError(rolledBack
    ? `${action} was refused: ${error.message}`
    : `${action} returned no reliable outcome: ${error.message} Inspect the source records before any new request.`,
  retryable, !rolledBack);
}

function ownedIdentity(config: RuntimeConfig): { workerId: string; buildSha: string } {
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

/**
 * Proof publication.
 *
 * The only action with an executor today, and the one that shows what this
 * gate is for. It performs no external write itself: it turns one
 * campaign-level human decision into the placement approvals that decision
 * named, re-checking each payload hash at release, and the proof placement
 * sweep owns the transport from there.
 *
 * Everything skipped is a placement whose words or state moved after the
 * person read them. Releasing nothing at all is a failure worth a person
 * seeing rather than a quiet success with a zero in it.
 */
export const releaseProofPlacements: ActionHandler = async (sb, config, action) => {
  const { workerId, buildSha } = ownedIdentity(config);
  const { data, error } = await sb.rpc("release_campaign_proof_placements_owned_v6", {
    p_execution_id: action.execution_id,
    p_worker_id: workerId,
    p_build_sha: buildSha,
  } as never);
  if (error) throw internalRpcFailure(error, "Proof placement release");

  const outcome = (data ?? {}) as { released?: number; skipped?: unknown[] };
  const released = Number(outcome.released ?? 0);
  const skipped = Array.isArray(outcome.skipped) ? outcome.skipped : [];

  if (released === 0) {
    const why = skipped
      .map((item) => String((item as { reason?: string }).reason ?? "no reason recorded"))
      .join(" ");
    throw new ActionError(
      `Nothing was released. ${why || "This campaign had no placement waiting on this decision."}`,
      false,
    );
  }

  return {
    result: { released, skipped },
    detail:
      skipped.length === 0
        ? `Released ${released} placement${released === 1 ? "" : "s"}.`
        : `Released ${released}, skipped ${skipped.length}.`,
  };
};


/**
 * G11: enrol this campaign's own leads into one approved sequence.
 *
 * Sends nothing. The courier sends each message afterwards under 249's
 * per-message rules, so consent, suppression and the daily cap still apply
 * to every one — which is why enrolling a hundred people is not the same
 * risk as sending a hundred emails.
 *
 * Enrolling nobody is a non-retryable failure rather than a success: the
 * approval said some leads were eligible, and if none are by the time the
 * sweep runs then something changed and a person should see why.
 */
export const enrolCampaignLeads: ActionHandler = async (sb, config, action) => {
  const { workerId, buildSha } = ownedIdentity(config);
  const { data, error } = await sb.rpc("enrol_campaign_leads_owned_v6", {
    p_execution_id: action.execution_id,
    p_worker_id: workerId,
    p_build_sha: buildSha,
  } as never);
  if (error) throw internalRpcFailure(error, "Campaign lead enrolment");

  const outcome = (data ?? {}) as {
    enrolled?: number; skipped?: unknown[]; sequence_name?: string;
  };
  const enrolled = Number(outcome.enrolled ?? 0);
  const skipped = Array.isArray(outcome.skipped) ? outcome.skipped : [];

  if (enrolled === 0) {
    const why = skipped
      .map((item) => String((item as { reason?: string }).reason ?? "no reason recorded"))
      .slice(0, 3)
      .join(" ");
    throw new ActionError(
      `Nobody was enrolled. ${why || "No lead from this campaign was eligible by the time this ran."}`,
      false,
    );
  }

  return {
    result: { enrolled, skipped, sequence: outcome.sequence_name ?? null },
    detail:
      skipped.length === 0
        ? `Enrolled ${enrolled} lead${enrolled === 1 ? "" : "s"} into ${outcome.sequence_name ?? "the sequence"}.`
        : `Enrolled ${enrolled}, skipped ${skipped.length}.`,
  };
};

export const HANDLERS: Readonly<Record<string, ActionHandler>> = {
  proof_publish: releaseProofPlacements,
  // Publishes the exact reviewed bytes, then submits a test form against the
  // live page and checks a sourced, consented lead arrives. See page-deploy.ts
  // for why the probe is the half that matters.
  page_deploy: deployCampaignPage,
  // Enrols leads; the courier is what actually sends.
  lead_message: enrolCampaignLeads,
  // The only handler that moves money, and the only one whose database check
  // runs inside the handler rather than in the claim.
  budget_change: changeAdSetBudget,
};

export async function runCampaignActionJob(
  sb: SupabaseClient,
  runtime: RuntimeConfig,
  _agent: AgentRow,
  job: AgentJobRow,
): Promise<JobResult> {
  if (!runtime.campaignActionsEnabled) {
    await appendEvent(
      sb,
      job.id,
      "External campaign actions are off in this runtime (CAMPAIGN_ACTIONS_ENABLED). Nothing was claimed.",
      "info",
    );
    return { ok: true, retryable: false };
  }

  if (!runtime.campaignActionOwnedClaimEnabled) {
    const failureMessage = `${GENERIC_CAMPAIGN_ACTION_CLAIM_HOLD} No action was claimed.`;
    await appendEvent(sb, job.id, failureMessage, "warn");
    return { ok: false, retryable: false, failureMessage };
  }
  const workerId = runtime.campaignActionWorkerId;
  const buildSha = deployedCommitSha();
  const keys = Object.keys(HANDLERS);
  if (!workerId || !buildSha || keys.length !== Object.keys(ACTION_HANDLER_MODULES).length
    || keys.some((key) => !(key in ACTION_HANDLER_MODULES))) {
    const failureMessage = "Campaign action handler ownership or deployed build identity is unavailable. No action was claimed.";
    await appendEvent(sb, job.id, failureMessage, "warn");
    return { ok: false, retryable: false, failureMessage };
  }
  const rawLimit = job.params?.limit;
  const limit = typeof rawLimit === "number" && Number.isInteger(rawLimit)
    ? Math.max(1, Math.min(rawLimit, 10)) : 3;
  const { data, error } = await sb.rpc("claim_campaign_actions_owned_v6", {
    p_worker_id: workerId,
    p_build_sha: buildSha,
    p_handlers: ACTION_HANDLER_MODULES,
    p_limit: limit,
  } as never);
  if (error) {
    const failureMessage = `Atomic campaign action claim refused: ${error.message}`;
    await appendEvent(sb, job.id, failureMessage, "warn");
    return { ok: false, retryable: true, failureMessage };
  }
  const claimed = Array.isArray(data) ? data as ClaimedAction[] : [];
  if (claimed.length === 0) {
    await appendEvent(sb, job.id, "No approved campaign action was eligible for this worker.", "info");
    return { ok: true, retryable: false };
  }
  const failures: string[] = [];
  for (const action of claimed) {
    const handler = HANDLERS[action.action_key];
    let completedDetail = "outcome recorded";
    try {
      if (!handler) throw new ActionError(`No handler is registered for ${action.action_key}.`);
      const outcome = await handler(sb, runtime, action);
      const recorded = await sb.rpc("record_campaign_action_executed", {
        p_execution_id: action.execution_id,
        p_external_id: outcome.externalId ?? null,
        p_external_url: outcome.externalUrl ?? null,
        p_result: { ...(outcome.result ?? {}), detail: outcome.detail ?? null },
      } as never);
      if (recorded.error) {
        throw new ActionError(
          `The action may have completed but its outcome could not be recorded: ${recorded.error.message}`
          + (outcome.externalId ? ` Provider ID: ${outcome.externalId}.` : "")
          + (outcome.externalUrl ? ` Provider URL: ${outcome.externalUrl}.` : ""),
          false,
          true,
          outcome.externalId,
          outcome.externalUrl,
          outcome.result,
        );
      }
      completedDetail = outcome.detail ?? completedDetail;
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      const retryable = cause instanceof ActionError && cause.retryable;
      const uncertain = cause instanceof ActionError && cause.outcomeUncertain;
      const recorded = uncertain
        ? await sb.rpc("record_campaign_action_uncertain_v6", {
          p_execution_id: action.execution_id, p_reason: reason,
          p_external_id: cause.externalId, p_external_url: cause.externalUrl,
          p_result: cause.result,
        } as never)
        : await sb.rpc("record_campaign_action_failure", {
          p_execution_id: action.execution_id, p_reason: reason, p_retryable: retryable,
        } as never);
      failures.push(`${action.action_key}: ${reason}`);
      if (recorded.error) failures.push(`Outcome receipt could not be recorded: ${recorded.error.message}`);
      await appendEvent(sb, job.id,
        `${action.action_key} ${uncertain ? "outcome uncertain" : "failed"} for ${action.client_id}: ${reason}`, "error");
      continue;
    }
    await appendEvent(sb, job.id,
      `${action.action_key} completed for ${action.client_id}: ${completedDetail}`, "info");
  }
  if (failures.length > 0) return {
    ok: false, retryable: false,
    failureMessage: `${failures.length} campaign action problem${failures.length === 1 ? "" : "s"}: ${failures.join(" ")}`,
  };
  return { ok: true, retryable: false };
}
