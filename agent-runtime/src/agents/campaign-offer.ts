import type { SupabaseClient } from "@supabase/supabase-js";

export type CampaignOfferSnapshot = {
  id: string;
  service_name: string;
  version: number;
  audience: string;
  promise: string;
  inclusions: string[];
  exclusions: string[];
  price_amount: number | null;
  currency: string | null;
  claims: unknown[];
  content_hash: string;
};

export async function loadArtifactCampaignOffer(
  sb: SupabaseClient,
  jobId: string,
  kind: "page" | "sales_agent",
): Promise<CampaignOfferSnapshot | null> {
  const { data, error } = await sb.rpc("capture_campaign_artifact_offer_v6", {
    p_job_id: jobId,
    p_artifact_kind: kind,
  });
  if (error) throw new Error(`Failed to capture campaign offer for ${kind}: ${error.message}`);
  if (data === null) return null;
  if (typeof data !== "object" || typeof data.id !== "string"
    || typeof data.promise !== "string" || typeof data.content_hash !== "string") {
    throw new Error(`Campaign ${kind} offer snapshot is invalid.`);
  }
  return data as CampaignOfferSnapshot;
}
