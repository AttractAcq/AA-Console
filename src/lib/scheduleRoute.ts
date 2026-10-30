import { supabase } from "./supabase";

export const PAID_SCHEDULING_BLOCKER =
  "Paid scheduling is unavailable until its own distribution route is released. Use the paid campaign workflow.";

export const PAID_CAMPAIGN_SCHEDULING_BLOCKER =
  "Scheduling blocked: this asset belongs to a paid campaign and cannot use organic distribution.";

export const UNVERIFIED_SCHEDULING_BLOCKER =
  "Scheduling blocked: this asset has no verified organic campaign route. Check its brief, idea and campaign linkage.";

export class ScheduleRouteBlockedError extends Error {
  readonly code = "schedule_route_blocked";
  readonly reason: "paid_channel" | "paid_campaign" | "unverified";

  constructor(reason: "paid_channel" | "paid_campaign" | "unverified") {
    super(reason === "paid_channel" ? PAID_SCHEDULING_BLOCKER
      : reason === "paid_campaign" ? PAID_CAMPAIGN_SCHEDULING_BLOCKER
        : UNVERIFIED_SCHEDULING_BLOCKER);
    this.name = "ScheduleRouteBlockedError";
    this.reason = reason;
  }
}

/**
 * The current schedule_asset RPC accepts either channel without checking
 * campaign lineage. Until the database route gate is released, every browser
 * caller must prove an explicit organic campaign immediately before the RPC.
 * An unreadable or incomplete chain is unknown, never an organic default.
 */
export async function assertOrganicScheduleRoute(
  assetId: string,
  channel: string,
  expectedClientId?: string,
): Promise<void> {
  if (channel !== "organic") {
    throw new ScheduleRouteBlockedError(channel === "paid" ? "paid_channel" : "unverified");
  }
  if (!assetId) throw new ScheduleRouteBlockedError("unverified");

  try {
    const { data: asset, error: assetError } = await supabase
      .from("client_media_assets")
      .select("id, client_id, brief_id")
      .eq("id", assetId)
      .maybeSingle();
    if (assetError || !asset?.brief_id || (expectedClientId !== undefined && asset.client_id !== expectedClientId)) {
      throw new ScheduleRouteBlockedError("unverified");
    }

    const { data: brief, error: briefError } = await supabase
      .from("client_briefs")
      .select("id, client_id, source_idea_id")
      .eq("id", asset.brief_id)
      .maybeSingle();
    if (briefError || !brief?.source_idea_id || brief.client_id !== asset.client_id) {
      throw new ScheduleRouteBlockedError("unverified");
    }

    const { data: idea, error: ideaError } = await supabase
      .from("client_ideas")
      .select("id, client_id, campaign_id")
      .eq("id", brief.source_idea_id)
      .maybeSingle();
    if (ideaError || !idea?.campaign_id || idea.client_id !== asset.client_id) {
      throw new ScheduleRouteBlockedError("unverified");
    }

    const { data: campaign, error: campaignError } = await supabase
      .from("client_campaigns")
      .select("id, client_id, acquisition_mode, paid_platform")
      .eq("id", idea.campaign_id)
      .maybeSingle();
    if (campaignError || !campaign || campaign.client_id !== asset.client_id) {
      throw new ScheduleRouteBlockedError("unverified");
    }
    if (campaign.acquisition_mode === "paid") throw new ScheduleRouteBlockedError("paid_campaign");
    if (campaign.acquisition_mode !== "organic" || campaign.paid_platform !== null) {
      throw new ScheduleRouteBlockedError("unverified");
    }
  } catch (error) {
    if (error instanceof ScheduleRouteBlockedError) throw error;
    throw new ScheduleRouteBlockedError("unverified");
  }
}
