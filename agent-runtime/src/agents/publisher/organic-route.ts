import type { SupabaseClient } from "@supabase/supabase-js";

import { PublishError } from "../../publishing/types.js";

export interface OrganicRouteClaim {
  post_id: string;
  client_id: string;
  asset_id: string | null;
  platform: string;
}

/**
 * A claim is not proof of an organic route: the current SQL claim can select
 * paid posts, and scheduled_posts.channel defaults to organic for old rows.
 * Follow the scheduled post back through its slot, idea and campaign before
 * giving an adapter a credential or letting it make an external write.
 * Missing, ambiguous and mismatched lineage always stops publication.
 */
export async function requireOrganicRoute(
  sb: SupabaseClient,
  claim: OrganicRouteClaim,
): Promise<void> {
  const { data: post, error: postError } = await sb
    .from("scheduled_posts")
    .select("id, client_id, asset_id, platform, channel, publication_status, published_at")
    .eq("id", claim.post_id)
    .maybeSingle();
  if (postError) throw new PublishError("Could not verify the scheduled post route.", true);
  if (!post || post.channel !== "organic" || post.publication_status !== "publishing" ||
      post.published_at !== null || post.client_id !== claim.client_id ||
      post.asset_id === null || post.asset_id !== claim.asset_id ||
      post.platform !== claim.platform) {
    throw new PublishError("The claimed post has no current, explicit organic route.", false);
  }

  const { data: slot, error: slotError } = await sb
    .from("content_slots")
    .select("id, client_id, asset_id, platform, stage, idea_id")
    .eq("scheduled_post_id", claim.post_id)
    .maybeSingle();
  if (slotError) throw new PublishError("Could not verify the post's content slot route.", true);
  if (!slot || slot.stage !== "scheduled" || slot.client_id !== claim.client_id ||
      slot.asset_id !== claim.asset_id || slot.platform !== claim.platform || !slot.idea_id) {
    throw new PublishError("The claimed post has no current, explicit organic route.", false);
  }

  const { data: idea, error: ideaError } = await sb
    .from("client_ideas")
    .select("id, client_id, campaign_id")
    .eq("id", slot.idea_id)
    .maybeSingle();
  if (ideaError) throw new PublishError("Could not verify the post's idea route.", true);
  if (!idea || idea.client_id !== claim.client_id || !idea.campaign_id) {
    throw new PublishError("The claimed post has no current, explicit organic route.", false);
  }

  const { data: campaign, error: campaignError } = await sb
    .from("client_campaigns")
    .select("id, client_id, acquisition_mode")
    .eq("id", idea.campaign_id)
    .maybeSingle();
  if (campaignError) throw new PublishError("Could not verify the post's campaign route.", true);
  if (!campaign || campaign.client_id !== claim.client_id || campaign.acquisition_mode !== "organic") {
    throw new PublishError("The claimed post has no current, explicit organic route.", false);
  }
}
