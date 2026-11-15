import type { SupabaseClient } from "@supabase/supabase-js";
import { readAdSetBudget } from "../../meta/ads.js";
import { accountFor } from "./budget-change.js";

interface Target {
  execution_id: string;
  client_id: string;
  ad_set_external_id: string;
  currency: string;
  prior_daily_budget: string | null;
  proposed_daily_budget: string;
}

function validTarget(value: unknown): value is Target {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return ["execution_id", "client_id", "ad_set_external_id", "currency", "proposed_daily_budget"]
    .every((key) => typeof row[key] === "string" && String(row[key]).length > 0)
    && /^[0-9]+$/.test(String(row.ad_set_external_id));
}

/** One provider GET. A matching value is evidence of state, not proof of causation. */
export async function reconcileUncertainBudget(
  sb: SupabaseClient, executionId: string, clientId: string,
): Promise<{ status: "held" | "matches_proposed" | "matches_prior" | "different";
  reason?: string }> {
  const { data, error } = await sb.rpc("campaign_budget_readback_target_v6", {
    p_execution_id: executionId, p_client_id: clientId,
  } as never);
  if (error) throw new Error("Could not load the uncertain budget action.");
  if (!validTarget(data) || data.execution_id !== executionId || data.client_id !== clientId) {
    return { status: "held", reason: "No current uncertain budget action belongs to this client." };
  }
  const account = await accountFor(sb, clientId);
  const observation = await readAdSetBudget(account, data.ad_set_external_id);
  if (observation.id !== data.ad_set_external_id || observation.accountId !== account.accountId) {
    return { status: "held", reason: "Meta returned a different ad set or account; inspect the connection." };
  }
  const accountAfter = await accountFor(sb, clientId);
  if (accountAfter.accountId !== account.accountId || accountAfter.accessToken !== account.accessToken) {
    return { status: "held", reason: "The Meta account or credential changed during readback." };
  }
  const { data: recorded, error: recordError } = await sb.rpc("record_campaign_budget_readback_v6", {
    p_execution_id: executionId, p_client_id: clientId,
    p_ad_set_external_id: observation.id, p_account_id: observation.accountId,
    p_observed_currency: observation.currency,
    p_observed_daily_budget_minor: observation.dailyBudgetMinor,
  } as never);
  if (recordError || !["matches_proposed", "matches_prior", "different"].includes(String(recorded))) {
    throw new Error("The read-only Meta budget observation could not be recorded.");
  }
  return { status: recorded as "matches_proposed" | "matches_prior" | "different" };
}
