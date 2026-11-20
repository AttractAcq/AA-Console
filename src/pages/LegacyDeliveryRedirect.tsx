import { Navigate, useLocation, useParams } from "react-router-dom";

import { legacyDeliveryRedirects } from "../config/navigation";

const retiredTabs: Record<string, Record<string, string | null>> = {
  "edit-repurpose": { overview: "edit" },
  reporting: { attribution: "overview" },
  "campaign-execution": { overview: null },
  conversion: {
    "primary-landing-pages": "landing-pages",
    "secondary-offer-pages": "offer-pages",
  },
  sales: { overview: "agents" },
  economics: { overview: "economics" },
};

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
 * Retired tab IDs are translated to their current destinations. Strategy is
 * another exception because its old `view=v1/v2` meant a model version,
 * while Intelligence OS uses `view=strategy` for its section.
 */
export function LegacyDeliveryRedirect({ from }: { from: string }) {
  const { clientId } = useParams<{ clientId: string }>();
  const { search } = useLocation();
  const [defaultPath, defaults = ""] = legacyDeliveryRedirects[from]!.split("?");
  let path = defaultPath;
  const params = new URLSearchParams(defaults);
  for (const [key, value] of new URLSearchParams(search)) params.set(key, value);
  const oldTab = params.get("tab");
  if (from === "distribution" && oldTab === "paid") path = "meta-ads-studio";
  if (oldTab !== null && Object.hasOwn(retiredTabs[from] ?? {}, oldTab)) {
    const currentTab = retiredTabs[from]![oldTab];
    if (currentTab === null) params.delete("tab");
    else params.set("tab", currentTab);
  }
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
