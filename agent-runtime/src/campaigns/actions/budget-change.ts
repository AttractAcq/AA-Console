/**
 * Changing an ad set's daily budget — G07.
 *
 * The only handler in the executor that moves money, so it is the one with
 * the narrowest definition of retryable and the most re-checking.
 *
 * WHAT IS RE-CHECKED, AND WHY HERE
 *
 * `assert_budget_change_allowed_v6` re-hashes the ad set and the exact
 * figure immediately before the write. The approval was given for one
 * number; a number edited afterwards produces a different hash and this
 * refuses. That check could not live in `campaign_action_due`, because the
 * view cannot know what the row looked like when somebody said yes.
 *
 * An ambiguous provider response, failed readback, or failed local recording
 * needs reconciliation before another write. The worker does not retry these
 * outcomes automatically, even though setting the same figure twice is a
 * provider-level no-op.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../../config.js";
import { ActionError, assertActionPrewrite, type ActionHandler } from "./executor.js";
import { MetaWriteError, readAdSetBudget, updateAdSetDailyBudget } from "../../meta/ads.js";
import { adAccountFor } from "../../meta/account.js";

interface BudgetChange {
  id: string;
  client_id: string;
  campaign_id: string;
  ad_set_external_id: string;
  current_daily_budget: string | number | null;
  proposed_daily_budget: string | number;
  currency: string;
}

/** The ad account and its token, read the same way the builder reads them. */
async function accountFor(
  sb: SupabaseClient,
  clientId: string,
): Promise<{ accessToken: string; accountId: string }> {
  const { data: eligible, error: grantError } = await sb.rpc("meta_budget_credential_eligible_v6", {
    p_client_id: clientId,
  } as never);
  if (grantError) {
    throw new ActionError(`Could not check the Meta budget credential grant: ${grantError.message}`, false);
  }
  if (eligible !== true) {
    throw new ActionError("A current, AAL2-reviewed Meta write credential is required.", false);
  }
  const { data, error } = await sb
    .from("client_integrations")
    .select("*")
    .eq("client_id", clientId)
    .eq("provider", "meta")
    .maybeSingle();
  if (error) throw new ActionError(`Could not read the Meta integration: ${error.message}`, true);
  if (!data) throw new ActionError("This client has no Meta integration.", false);

  const resolved = adAccountFor(data as never);
  if ("problem" in resolved) throw new ActionError(resolved.problem, false);

  const { data: token, error: tokenError } = await sb.rpc("integration_secret", {
    p_client_id: clientId,
    p_provider: "meta",
  } as never);
  if (tokenError) {
    throw new ActionError(`Could not read the Meta credential: ${tokenError.message}`, true);
  }
  if (typeof token !== "string" || !token) {
    throw new ActionError("This client's Meta credential is missing.", false);
  }
  return { accessToken: token, accountId: resolved.id };
}

export const changeAdSetBudget: ActionHandler = async (sb, config: RuntimeConfig, action) => {
  // The money check, immediately before the write.
  const { data, error } = await sb.rpc("assert_budget_change_allowed_v6", {
    p_execution_id: action.execution_id,
  } as never);
  if (error) {
    // The database's own sentence: "The budget or the ad set changed after
    // this was approved." Not retryable — a person has to ask again.
    throw new ActionError(error.message, false);
  }
  const change = (Array.isArray(data) ? data[0] : data) as BudgetChange | null;
  if (!change?.id) throw new ActionError("That approval names no budget change.", false);

  const account = await accountFor(sb, change.client_id);
  const amount = Number(change.proposed_daily_budget);
  const current = Number(change.current_daily_budget);
  const decimals = new Intl.NumberFormat("en", { style: "currency", currency: change.currency })
    .resolvedOptions().maximumFractionDigits;
  if (!Number.isFinite(current) || current <= 0 || !Number.isFinite(amount)
    || decimals !== 2) {
    throw new ActionError("This budget change needs a known current amount and a two-decimal account currency.");
  }
  let before;
  try {
    before = await readAdSetBudget(account, change.ad_set_external_id);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new ActionError(`Meta budget preflight refused: ${reason}`, false);
  }
  if (before.currency !== change.currency
    || before.dailyBudgetMinor !== Math.round(current * 100)) {
    throw new ActionError("Meta's current account currency or ad-set budget differs from the reviewed change.");
  }

  await assertActionPrewrite(sb, config, action);
  const currentAccount = await accountFor(sb, change.client_id);
  if (currentAccount.accountId !== account.accountId
    || currentAccount.accessToken !== account.accessToken) {
    throw new ActionError("The Meta account or credential changed before the budget write.");
  }
  try {
    await updateAdSetDailyBudget(account, change.ad_set_external_id, amount);
  } catch (thrown) {
    const reason = thrown instanceof Error ? thrown.message : String(thrown);
    throw new ActionError(thrown instanceof MetaWriteError && thrown.retryable
      ? `Meta budget write outcome is uncertain: ${reason} Reconcile the ad set before any retry.`
      : `Meta budget write was invoked: ${reason} Inspect the ad set before another request.`,
      false, true, change.ad_set_external_id);
  }
  let after;
  try {
    after = await readAdSetBudget(account, change.ad_set_external_id);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new ActionError(`Meta budget write was requested but readback failed: ${reason} Reconcile before retrying.`,
      false, true, change.ad_set_external_id);
  }
  if (after.currency !== change.currency
    || after.dailyBudgetMinor !== Math.round(amount * 100)) {
    throw new ActionError("Meta budget readback differs from the approved amount. Reconcile before retrying.",
      false, true, change.ad_set_external_id,
      null, { observed_budget_minor: after.dailyBudgetMinor, currency: after.currency });
  }

  const { error: recordError } = await sb.rpc("record_budget_change_applied", {
    p_change_id: change.id,
    p_external_ref: change.ad_set_external_id,
  } as never);
  // Meta confirmed the amount, but the local effect was not recorded. A
  // retry would fail its old-budget preflight, so hold for reconciliation.
  if (recordError) {
    throw new ActionError(
      `Meta confirmed the budget, but recording it failed: ${recordError.message} Reconcile before retrying.`,
      false,
      true,
      change.ad_set_external_id,
      null,
      { observed_budget_minor: after.dailyBudgetMinor, currency: after.currency },
    );
  }

  return {
    result: {
      budget_change_id: change.id,
      ad_set_external_id: change.ad_set_external_id,
      daily_budget: amount,
      currency: change.currency,
      provider_readback_minor: after.dailyBudgetMinor,
    },
    externalId: change.ad_set_external_id,
    detail: `Daily budget set to ${amount} ${change.currency} on ad set ${change.ad_set_external_id}.`,
  };
};
