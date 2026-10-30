/**
 * The campaign action executor.
 *
 * Migration 206 gave a person a way to say yes to one exact campaign
 * package, one action, one destination and one artifact version. Migration
 * 230 gave that yes a lifecycle. This is the thing that reads it.
 *
 * A sweep rather than a job per action, for the same reason the publisher is
 * one: what is approved and unblocked is a question about state, not about
 * any single row, and one claim of three actions is one lease instead of
 * three.
 *
 * OFF IS A STATE, NOT AN ERROR
 *
 * With CAMPAIGN_ACTIONS_ENABLED unset this does nothing and says so,
 * successfully. Not a dry run that pretends: a dry run reporting success
 * would have the database record an execution that never happened, which is
 * a lie told in the one place a person checks before asking why the client's
 * ads are not live.
 *
 * ONE HANDLER PER ACTION, AND NO DEFAULT
 *
 * There is no fallback handler. Before any claim, the runtime compares all
 * database support claims with HANDLERS and refuses the sweep if one has no
 * handler. The post-claim check remains as a last guard if the registry
 * changes after that read; it records a non-retryable failure rather than
 * attempting an external action.
 *
 * WHAT THIS DOES NOT DECIDE
 *
 * Not whether the package is current, not whether the client is switched on,
 * not whether the approval is stale. `campaign_action_due` decides all of
 * that and `claim_campaign_actions` only claims rows it has cleared, so the
 * revalidation happens inside the same locked statement as the claim. A
 * handler that needs a narrower check than the view can express does it
 * itself, immediately before its write.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { logger } from "../../logging/logger.js";
import { deployCampaignPage } from "./page-deploy.js";
import { changeAdSetBudget } from "./budget-change.js";
import { inspectCampaignActionRegistry } from "./support.js";

const DEFAULT_BATCH = 3;

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
export const releaseProofPlacements: ActionHandler = async (sb, _config, action) => {
  const { data, error } = await sb.rpc("release_campaign_proof_placements", {
    p_execution_id: action.execution_id,
  } as never);
  if (error) throw new ActionError(`Could not release the placements: ${error.message}`, true);

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
export const enrolCampaignLeads: ActionHandler = async (sb, _config, action) => {
  const { data, error } = await sb.rpc("enrol_campaign_leads_in_sequence_v6", {
    p_execution_id: action.execution_id,
  } as never);
  if (error) throw new ActionError(`Could not enrol the leads: ${error.message}`, true);

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
  agent: AgentRow,
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

  // `claim_campaign_actions` has no action-key filter. A SQL support flag
  // without a handler could therefore consume an exact human approval and
  // abandon it before any provider write. Check every supported key before
  // claiming anything; a partial/failed read blocks the whole sweep.
  let unhandledSupportedKeys: string[];
  try {
    const { data, error } = await sb.from("campaign_action_executors")
      .select("action_key,executor_module,supported")
      .order("action_key");
    if (error) throw new Error("Campaign action registry read failed.");
    ({ unhandledSupportedKeys } = inspectCampaignActionRegistry(
      data, new Set(Object.keys(HANDLERS)),
    ));
  } catch {
    const failureMessage = "Campaign action support could not be verified against this runtime. No action was claimed.";
    await appendEvent(sb, job.id, failureMessage, "warn");
    return { ok: false, retryable: false, failureMessage };
  }
  if (unhandledSupportedKeys.length > 0) {
    const failureMessage =
      `Database marks ${unhandledSupportedKeys.join(", ")} supported, but this runtime has no campaign action handler. No action was claimed.`;
    await appendEvent(sb, job.id, failureMessage, "warn");
    return { ok: false, retryable: false, failureMessage };
  }

  const asked = Number((job.params as Record<string, unknown> | null)?.limit ?? DEFAULT_BATCH);
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.trunc(asked), 20) : DEFAULT_BATCH;
  const { data, error } = await sb.rpc("claim_campaign_actions", { p_limit: limit } as never);
  if (error) throw new Error(`Could not claim campaign actions: ${error.message}`);

  const claimed = (data ?? []) as ClaimedAction[];
  if (claimed.length === 0) {
    await appendEvent(sb, job.id, "No approved action is waiting.", "info");
    return { ok: true, retryable: false };
  }

  let executed = 0;
  let failed = 0;

  for (const action of claimed) {
    try {
      const handler = HANDLERS[action.action_key];
      if (!handler) {
        throw new ActionError(
          `There is no executor for ${action.action_key.replace(/_/g, " ")} in this runtime.`,
          false,
        );
      }
      const outcome = await handler(sb, runtime, action);

      const { error: recordError } = await sb.rpc("record_campaign_action_executed", {
        p_execution_id: action.execution_id,
        p_external_id: outcome.externalId ?? null,
        p_external_url: outcome.externalUrl ?? null,
        p_result: outcome.result ?? null,
      } as never);
      // The act has happened. A failure to record it leaves the row claimed
      // for the reaper, which abandons it and says to go and look -- wrong,
      // but visible, and the right instruction.
      if (recordError) {
        throw new Error(`Done, but could not be recorded: ${recordError.message}`);
      }

      executed += 1;
      await appendEvent(
        sb,
        job.id,
        `${action.action_key}: ${outcome.detail ?? "done"}.`,
        "info",
        {
          approval_id: action.approval_id,
          campaign_id: action.campaign_id,
          external_id: outcome.externalId ?? null,
        },
      );
      logger.info("campaign_action_executed", {
        jobId: job.id,
        approvalId: action.approval_id,
        actionKey: action.action_key,
      });
    } catch (thrown) {
      failed += 1;
      const retryable = thrown instanceof ActionError ? thrown.retryable : false;
      const reason = thrown instanceof Error ? thrown.message : String(thrown);
      const { error: failError } = await sb.rpc("record_campaign_action_failure", {
        p_execution_id: action.execution_id,
        p_reason: reason,
        p_retryable: retryable,
      } as never);
      if (failError) {
        logger.error("campaign_action_failure_unrecorded", {
          jobId: job.id,
          approvalId: action.approval_id,
          message: failError.message,
        });
      }
      await appendEvent(sb, job.id, `${action.action_key}: ${reason}`, "warn", {
        approval_id: action.approval_id,
        retryable,
      });
    }
  }

  await appendEvent(sb, job.id, `${executed} done, ${failed} not.`, failed > 0 ? "warn" : "info", {
    executed,
    failed,
    claimed: claimed.length,
  });

  void agent;
  // The sweep did its job even when an action inside it did not: each
  // failure is recorded against its own execution, and a retry of the sweep
  // re-claims only what is genuinely still unblocked.
  return { ok: true, retryable: false };
}
