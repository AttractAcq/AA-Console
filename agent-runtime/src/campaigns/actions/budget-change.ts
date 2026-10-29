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
 * RETRYABLE IS NARROW BECAUSE A BUDGET CHANGE IS NOT IDEMPOTENT IN EFFECT
 *
 * Setting the same figure twice is harmless. Retrying a call that may have
 * succeeded is therefore safe, which is why a network fault is retryable.
 * What is not retryable is anything Meta refused deliberately: a revoked
 * token, an ad set the credential cannot see, a figure below the account's
 * floor. Those are three identical refusals in a log pretending to be
 * diligence.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../../config.js";
import { ActionError, type ActionHandler } from "./executor.js";
import { MetaWriteError, updateAdSetDailyBudget } from "../../meta/ads.js";
import { adAccountFor } from "../../meta/account.js";

interface BudgetChange {
  id: string;
  client_id: string;
  campaign_id: string;
  ad_set_external_id: string;
  proposed_daily_budget: string | number;
  currency: string;
}

/** The ad account and its token, read the same way the builder reads them. */
async function accountFor(
  sb: SupabaseClient,
  clientId: string,
): Promise<{ accessToken: string; accountId: string }> {
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

export const changeAdSetBudget: ActionHandler = async (sb, _config: RuntimeConfig, action) => {
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

  try {
    await updateAdSetDailyBudget(account, change.ad_set_external_id, amount);
  } catch (thrown) {
    const retryable = thrown instanceof MetaWriteError ? thrown.retryable : false;
    const reason = thrown instanceof Error ? thrown.message : String(thrown);
    throw new ActionError(reason, retryable);
  }

  const { error: recordError } = await sb.rpc("record_budget_change_applied", {
    p_change_id: change.id,
    p_external_ref: change.ad_set_external_id,
  } as never);
  // The budget has moved at Meta. Failing to record it leaves the row
  // claimed for the reaper, and a retry sets the same figure again, which
  // is a no-op rather than a second change.
  if (recordError) {
    throw new ActionError(`The budget changed, but recording it failed: ${recordError.message}`, true);
  }

  return {
    result: {
      budget_change_id: change.id,
      ad_set_external_id: change.ad_set_external_id,
      daily_budget: amount,
      currency: change.currency,
    },
    externalId: change.ad_set_external_id,
    detail: `Daily budget set to ${amount} ${change.currency} on ad set ${change.ad_set_external_id}.`,
  };
};
