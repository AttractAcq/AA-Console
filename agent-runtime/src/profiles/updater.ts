/**
 * Applying an approved profile change — G05, currently held before claim.
 *
 * `google_profile_changes` and `meta_profile_changes` have recorded
 * decisions since 240 and 241, with `applied` and `failed` statuses and
 * nothing to move them. This moves them, for the fields the platform
 * actually lets an adapter write.
 *
 * WHAT IT DOES NOT CLAIM
 *
 * `claim_profile_changes` joins `profile_field_support` and only claims
 * writable fields. An Instagram bio therefore never reaches this worker: it
 * stays approved, and `profile_change_due` shows it with the sentence
 * telling a person to edit it in the app. That is deliberate — failing it
 * five times and marking it failed would turn a job for a person into an
 * error nobody owns.
 *
 * UNPROVEN, AND SAYING SO
 *
 * The existing source decisions have no exact AAL2 Approval Inbox binding
 * or last-moment prewrite verifier. The worker stays held before any claim,
 * credential read or provider call. The adapter code remains available for
 * later integration and testing, but it does not establish live acceptance.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../config.js";
import type { AgentRow } from "../orchestration/registry.js";
import type { JobResult } from "../orchestration/dispatch.js";
import type { AgentJobRow } from "../queue.js";
import { appendEvent } from "../queue.js";
import { logger } from "../logging/logger.js";
import {
  PlacementTransportError, patchLocationField,
} from "../proof-distribution/google-business.js";
import { profileUpdatePrewriteProblem } from "./prewrite-gate.js";

const DEFAULT_BATCH = 5;

export interface ClaimedProfileChange {
  change_id: string;
  client_id: string;
  surface: string;
  platform: string;
  field: string;
  proposed_value: string;
  location_ref: string | null;
  attempts: number;
}

export async function applyProfileChanges(
  sb: SupabaseClient,
  config: RuntimeConfig,
  job: AgentJobRow,
  fetchImpl: typeof fetch = fetch,
): Promise<JobResult> {
  if (!config.campaignActionsEnabled) {
    await appendEvent(
      sb,
      job.id,
      "External campaign actions are off in this runtime (CAMPAIGN_ACTIONS_ENABLED). No profile change was claimed.",
      "info",
    );
    return { ok: true, retryable: false };
  }

  const prewriteProblem = profileUpdatePrewriteProblem();
  if (prewriteProblem) {
    await appendEvent(sb, job.id, prewriteProblem, "warn");
    return { ok: false, retryable: false, failureMessage: prewriteProblem };
  }

  // Unavailable until the exact AAL2 source and prewrite gate replace the
  // hold above. Retain the adapter so that transition can be reviewed as one
  // release rather than rebuilding the transport under a new approval model.
  const { data, error } = await sb.rpc("claim_profile_changes", {
    p_limit: DEFAULT_BATCH,
  } as never);
  if (error) {
    return {
      ok: false,
      retryable: true,
      failureMessage: `Could not claim profile changes: ${error.message}`,
    };
  }

  const claimed = (data ?? []) as ClaimedProfileChange[];
  if (claimed.length === 0) {
    await appendEvent(
      sb, job.id,
      "No approved profile change was waiting on a field an adapter may write.",
      "info",
    );
    return { ok: true, retryable: false };
  }

  let applied = 0;
  let failed = 0;

  for (const change of claimed) {
    try {
      if (change.surface !== "google_business") {
        // Only reachable if a surface is marked writable without an adapter.
        throw new PlacementTransportError(
          `No adapter applies a ${change.surface} profile change, although the field is marked writable.`,
          false,
        );
      }
      if (!change.location_ref) {
        throw new PlacementTransportError(
          "That change has no connected Business Profile location.",
          false,
        );
      }

      const { data: token, error: tokenError } = await sb.rpc("integration_secret", {
        p_client_id: change.client_id,
        p_provider: "google_business",
      } as never);
      if (tokenError) {
        throw new PlacementTransportError(
          `Could not read the Google credential: ${tokenError.message}`,
          true,
        );
      }
      if (typeof token !== "string" || !token) {
        throw new PlacementTransportError(
          "This client has no usable Google Business credential, so nothing can be written.",
          false,
        );
      }

      const { externalRef } = await patchLocationField({
        accessToken: token,
        accountRef: change.location_ref,
        field: change.field,
        value: change.proposed_value,
        fetchImpl,
      });

      const { error: recordError } = await sb.rpc("record_profile_change_applied", {
        p_change_id: change.change_id,
        p_external_ref: externalRef,
      } as never);
      if (recordError) {
        throw new PlacementTransportError(
          `Changed, but could not record it: ${recordError.message}`,
          true,
        );
      }

      applied += 1;
      await appendEvent(sb, job.id, `Set ${change.field} on the Business Profile.`, "info", {
        change_id: change.change_id, field: change.field,
      });
      logger.info("profile_change_applied", {
        jobId: job.id, changeId: change.change_id, field: change.field,
      });
    } catch (thrown) {
      failed += 1;
      const retryable = thrown instanceof PlacementTransportError ? thrown.retryable : false;
      const reason = thrown instanceof Error ? thrown.message : String(thrown);
      await sb.rpc("record_profile_change_failure", {
        p_change_id: change.change_id,
        p_reason: reason,
        p_retryable: retryable,
      } as never);
      await appendEvent(sb, job.id, `A profile change failed: ${reason}`, "warn", {
        change_id: change.change_id, retryable,
      });
    }
  }

  await appendEvent(
    sb, job.id,
    `${applied} applied, ${failed} failed, of ${claimed.length} claimed.`,
    failed > 0 ? "warn" : "info",
  );
  return { ok: true, retryable: false };
}

export async function runProfileUpdaterJob(
  sb: SupabaseClient,
  config: RuntimeConfig,
  _agent: AgentRow,
  job: AgentJobRow,
): Promise<JobResult> {
  return applyProfileChanges(sb, config, job);
}
