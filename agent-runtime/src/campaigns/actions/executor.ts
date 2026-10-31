/**
 * The campaign action executor.
 *
 * Migration 206 gave a person a way to say yes to one exact campaign
 * package, one action, one destination and one artifact version. Migration
 * 230 gave that yes a lifecycle. This worker entry point is presently held
 * before reading or claiming any approved action.
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
 * Migration 230's claim function cannot restrict a claim to handler-owned
 * action keys. The registry read and claim used to be separate requests, so
 * a support-bit change between them could consume an exact human approval.
 * The registered worker now stops before any registry read or claim. Handler
 * bodies remain available for direct unit tests and future atomic SQL
 * integration, but this entry point does not invoke them.
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

  const failureMessage = `${GENERIC_CAMPAIGN_ACTION_CLAIM_HOLD} No action was claimed.`;
  await appendEvent(sb, job.id, failureMessage, "warn");
  return { ok: false, retryable: false, failureMessage };
}
