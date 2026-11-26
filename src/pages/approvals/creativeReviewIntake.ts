import { supabase } from "../../lib/supabase";

type ReviewShape = {
  media_type: string;
  content_format: string | null;
  render_path: string | null;
};

export function canRequestOrdinaryReview(asset: ReviewShape): boolean {
  const format = asset.content_format ?? "single";
  return (asset.media_type === "image" || asset.media_type === "text")
    && (format === "single" || ((format === "carousel" || format === "story") && !asset.render_path));
}

export type CreativeReviewCandidate = { id: string; title: string | null; media_type: string };

export async function loadCreativeReviewIntake(clientId: string): Promise<CreativeReviewCandidate[]> {
  const candidates: CreativeReviewCandidate[] = [];
  const batchSize = 100;
  for (let offset = 0; ; offset += batchSize) {
    const assets = await supabase.from("client_media_assets")
      .select("id,title,media_type,content_format,render_path,edit_stage")
      .eq("client_id", clientId).eq("purpose", "client")
      .in("media_type", ["image", "text"])
      .or("review_status.eq.pending,and(review_status.eq.approved,human_approved_at.is.null)")
      .order("created_at", { ascending: false }).order("id")
      .range(offset, offset + batchSize - 1);
    if (assets.error) throw assets.error;
    const rows = assets.data ?? [];
    const eligible = rows.filter((asset) => (!asset.edit_stage || asset.edit_stage === "review_ready")
      && canRequestOrdinaryReview(asset));
    if (eligible.length) {
      const ids = eligible.map((asset) => asset.id);
      const [slots, reviews] = await Promise.all([
        supabase.from("content_slots").select("asset_id").eq("client_id", clientId)
          .eq("stage", "awaiting_approval").in("asset_id", ids),
        supabase.from("approval_inbox_v6").select("source_id").eq("client_id", clientId)
          .eq("source_system", "aa_console").eq("source_kind", "ordinary_media")
          .eq("status", "pending").in("source_id", ids),
      ]);
      if (slots.error) throw slots.error;
      if (reviews.error) throw reviews.error;
      const excluded = new Set([
        ...(slots.data ?? []).map((slot) => slot.asset_id),
        ...(reviews.data ?? []).map((review) => review.source_id),
      ]);
      candidates.push(...eligible.filter((asset) => !excluded.has(asset.id)));
    }
    if (rows.length < batchSize) return candidates;
  }
}
