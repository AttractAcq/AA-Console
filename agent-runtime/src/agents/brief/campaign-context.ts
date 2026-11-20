import type { SupabaseClient } from "@supabase/supabase-js";

/** The approved plan and exact offer govern a campaign brief, not the client's
 * general offer strategy. A missing or changed source is a production blocker. */
export async function loadCampaignBriefContext(
  sb: SupabaseClient, clientId: string, campaignId: string | null,
): Promise<{ text: string; blocker: string | null }> {
  if (!campaignId) return { text: "", blocker: null };

  const { data: campaign, error: campaignError } = await sb.from("client_campaigns")
    .select("id, client_id, campaign_kind, name, brief, audience, objective, core_message, offer_summary, channels, acquisition_mode, paid_platform, offer_version_id, plan_approved_at, plan_approved_fingerprint")
    .eq("id", campaignId).maybeSingle();
  if (campaignError) throw new Error(`Could not load campaign brief source: ${campaignError.message}`);
  if (!campaign || campaign.client_id !== clientId)
    return { text: "", blocker: "The idea's campaign is missing or belongs to another client." };
  if (campaign.campaign_kind && (!campaign.plan_approved_at || !campaign.plan_approved_fingerprint))
    return { text: "", blocker: "The campaign plan is not approved for content production." };
  if (campaign.campaign_kind) {
    const { data: blocker, error } = await sb.rpc("campaign_sweep_blocker_v6", {
      p_campaign_id: campaign.id,
    });
    if (error) throw new Error(`Could not verify current campaign plan: ${error.message}`);
    if (blocker) return { text: "", blocker: String(blocker) };
  }

  let offer: unknown = null;
  if (campaign.offer_version_id) {
    const { data, error } = await sb.rpc("capture_campaign_offer_v6", { p_campaign_id: campaign.id });
    if (error) throw new Error(`Could not verify campaign offer: ${error.message}`);
    if (!data || (data as { id?: string }).id !== campaign.offer_version_id)
      return { text: "", blocker: "The exact campaign offer version is unavailable or no longer approved." };
    offer = data;
  }

  let opportunity: unknown = null;
  if (campaign.campaign_kind === "opportunity_campaign") {
    const { data: link, error: linkError } = await sb.from("opportunity_links")
      .select("opportunity_id, client_id").eq("campaign_id", campaign.id)
      .eq("role", "campaign").maybeSingle();
    if (linkError) throw new Error(`Could not load campaign opportunity link: ${linkError.message}`);
    if (!link || link.client_id !== clientId)
      return { text: "", blocker: "The opportunity campaign has no valid client-owned market opportunity." };
    const { data, error } = await sb.from("market_opportunities")
      .select("id, client_id, name, status, micro_market, buying_situation, core_problem, desired_outcome, positioning, purchase_trigger, approved_content_hash")
      .eq("id", link.opportunity_id).maybeSingle();
    if (error) throw new Error(`Could not load campaign opportunity: ${error.message}`);
    if (!data || data.client_id !== clientId)
      return { text: "", blocker: "The campaign market opportunity is missing or belongs to another client." };
    if (!["approved", "active", "learning", "scaling"].includes(data.status)
      || !data.approved_content_hash)
      return { text: "", blocker: "The campaign market opportunity no longer has a current approval." };
    opportunity = data;
  }

  return { blocker: null, text: `CAMPAIGN APPROVED PLAN — authoritative for this brief
Campaign: ${campaign.name} (${campaign.id})
Plan fingerprint: ${campaign.plan_approved_fingerprint ?? "legacy plan"}
Route: ${campaign.acquisition_mode}${campaign.paid_platform ? ` / ${campaign.paid_platform}` : ""}
Channels: ${(campaign.channels ?? []).join(", ") || "unspecified"}
Objective: ${campaign.objective ?? "unspecified"}
Audience: ${campaign.audience ?? "unspecified"}
Core message: ${campaign.core_message ?? "unspecified"}
Planning brief: ${campaign.brief}
${offer ? `EXACT APPROVED OFFER VERSION — use this promise, price, claims and exclusions; do not replace them with general strategy\n${JSON.stringify(offer)}` : `Offer summary: ${campaign.offer_summary ?? "none selected"}. Do not invent an offer or price.`}
${opportunity ? `APPROVED MARKET OPPORTUNITY LINK — target this buying situation; it is context, not permission to invent demand or proof\n${JSON.stringify(opportunity)}` : ""}` };
}
