import type { SupabaseClient } from "@supabase/supabase-js";

/** A retry may have uploaded and filed an asset before attestation failed. */
export async function reusableGeneratedAsset(
  sb: SupabaseClient,
  clientId: string,
  briefId: string,
  path: string,
  mediaType: "image" | "text",
): Promise<string | null> {
  const { data, error } = await sb.from("client_media_assets")
    .select("id, brief_id, media_type, review_status, human_approved_at, archived_at")
    .eq("client_id", clientId).eq("storage_path", path).limit(2);
  if (error) throw new Error(`Could not check the generated asset path: ${error.message}`);
  const matches = data ?? [];
  if (!matches.length) return null;
  if (matches.length !== 1) {
    throw new Error("Generated asset path has multiple records; an operator must resolve them before retry.");
  }
  const asset = matches[0]!;
  if (asset.brief_id !== briefId || asset.media_type !== mediaType
    || asset.review_status !== "pending" || asset.human_approved_at || asset.archived_at) {
    throw new Error("Generated asset path belongs to a different or already reviewed asset; overwrite refused.");
  }
  return asset.id as string;
}

/** A complete frame set may already be filed when attestation or final status failed. */
export async function reusableFramedRenderAsset(
  sb: SupabaseClient,
  clientId: string,
  briefId: string,
  renderId: string,
  mediaType: "image" | "video",
  format: string,
): Promise<string | null> {
  const { data, error } = await sb.from("client_media_assets")
    .select("id, brief_id, media_type, content_format, review_status, human_approved_at, archived_at")
    .eq("client_id", clientId)
    .like("storage_path", `${clientId}/generated/${renderId}/01.%`)
    .limit(2);
  if (error) throw new Error(`Could not check the framed render path: ${error.message}`);
  const matches = data ?? [];
  if (!matches.length) return null;
  if (matches.length !== 1) {
    throw new Error("Framed render path has multiple asset records; an operator must resolve them before retry.");
  }
  const asset = matches[0]!;
  if (asset.brief_id !== briefId || asset.media_type !== mediaType
    || asset.content_format !== format || asset.review_status !== "pending"
    || asset.human_approved_at || asset.archived_at) {
    throw new Error("Framed render path belongs to a different or already reviewed asset; overwrite refused.");
  }
  return asset.id as string;
}
