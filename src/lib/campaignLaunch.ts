import { supabase } from "./supabase";
import type { Database } from "../types/database";

/**
 * Is this campaign actually live — G08.
 *
 * The distinction this module exists to keep visible is between two facts
 * that used to be one: every external action the route needs was approved and
 * executed, and something actually happened outside the building. A campaign
 * can be the first without being the second for a fortnight, because the last
 * step of a paid route is a person switching ads on in Ads Manager.
 *
 * `live` is therefore evidence, never an approval: a published post for an
 * organic campaign, recorded spend for a paid one.
 */

export type LaunchDue = Database["public"]["Views"]["campaign_launch_due"]["Row"];
export type LaunchStep = Database["public"]["Views"]["campaign_launch_readiness"]["Row"];

/** Every campaign's verdict for this client, keyed by campaign. */
export async function fetchLaunchDue(clientId: string): Promise<Map<string, LaunchDue>> {
  const { data, error } = await supabase
    .from("campaign_launch_due")
    .select("*")
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  return new Map(
    ((data ?? []) as LaunchDue[])
      .filter((row): row is LaunchDue & { campaign_id: string } => Boolean(row.campaign_id))
      .map((row) => [row.campaign_id, row]),
  );
}

/**
 * The per-action breakdown behind one campaign's verdict, in manifest order.
 *
 * Ordered by `item_key` to match the view's own choice of first blocker, so
 * the row a person reads first is the one the verdict is quoting.
 */
export async function fetchLaunchSteps(campaignId: string): Promise<LaunchStep[]> {
  const { data, error } = await supabase
    .from("campaign_launch_readiness")
    .select("*")
    .eq("campaign_id", campaignId)
    .order("item_key");
  if (error) throw new Error(error.message);
  return (data ?? []) as LaunchStep[];
}
