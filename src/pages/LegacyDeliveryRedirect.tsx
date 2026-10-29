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
 * Whatever query the old link carried is kept and wins over the default in
 * the map, so `media?tab=reel-shots` opens the reel shots library rather than
 * the top of Assets.
 */
export function LegacyDeliveryRedirect({ from }: { from: string }) {
  const { clientId } = useParams<{ clientId: string }>();
  const { search } = useLocation();
  const [path, defaults = ""] = legacyDeliveryRedirects[from]!.split("?");
  const params = new URLSearchParams(defaults);
  for (const [key, value] of new URLSearchParams(search)) params.set(key, value);
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
