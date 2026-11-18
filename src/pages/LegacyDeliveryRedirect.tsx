import { Navigate, useLocation, useParams } from "react-router-dom";

import { legacyDeliveryRedirects } from "../config/navigation";

/**
 * A replaced v5 Delivery URL, sent to the v6 page that took over its work.
 *
 * The pages are archived; the links to them are not. These paths were
 * bookmarked, pasted into chat and linked from records for a year, and a
 * bookmark that lands on the dashboard tells you nothing about where the
 * work went.
 *
 * Whatever query the old link carried is kept and normally wins over the
 * default in the map, so `media?tab=reel-shots` opens the reel shots library.
 * Strategy is the exception because its old `view=v1/v2` meant a model
 * version, while Intelligence OS uses `view=strategy` for its section.
 */
export function LegacyDeliveryRedirect({ from }: { from: string }) {
  const { clientId } = useParams<{ clientId: string }>();
  const { search } = useLocation();
  const [path, defaults = ""] = legacyDeliveryRedirects[from]!.split("?");
  const params = new URLSearchParams(defaults);
  for (const [key, value] of new URLSearchParams(search)) params.set(key, value);
  // The old Strategy page used `view=v1` and `view=v2` for model versions.
  // Intelligence OS uses `view=strategy` for the section itself, so a saved
  // Strategy URL must keep its section even when the old query is present.
  if (from === "strategy") params.set("view", "strategy");
  const query = params.toString();
  return (
    <Navigate replace to={`/clients/${clientId}/delivery/${path}${query ? `?${query}` : ""}`} />
  );
}

/** The same for one campaign's own page, which had its own legacy route. */
export function LegacyCampaignRedirect() {
  const { clientId, campaignId } = useParams<{ clientId: string; campaignId: string }>();
  return (
    <Navigate replace to={`/clients/${clientId}/delivery/campaign-factory/${campaignId}`} />
  );
}
