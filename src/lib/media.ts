import { supabase } from "./supabase";

/**
 * Signs a batch of storage paths in one round trip. Buckets are private,
 * so nothing renders without this.
 */
export async function signPaths(
  bucket: string,
  paths: string[],
  expiresIn = 3600,
): Promise<Map<string, string>> {
  const unique = [...new Set(paths.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const { data, error } = await supabase.storage.from(bucket).createSignedUrls(unique, expiresIn);
  if (error || !data) return new Map();

  return new Map(
    data
      .filter((d) => d.signedUrl && !d.error)
      .map((d) => [d.path ?? "", d.signedUrl] as [string, string]),
  );
}

export type MediaAsset = {
  id: string;
  client_id: string;
  brief_id: string | null;
  ref_number: string | null;
  media_type: "image" | "text" | "video";
  title: string | null;
  storage_path: string;
  review_status: "pending" | "approved" | "rejected";
  member_id: string | null;
  created_at: string;
};

export const REVIEW_TONE: Record<MediaAsset["review_status"], string> = {
  pending: "bg-secondary text-secondary-foreground",
  approved: "bg-primary/10 text-brand-strong",
  rejected: "bg-destructive/10 text-destructive",
};

export async function fetchClientAssets(
  clientId: string,
  opts: { mediaType?: MediaAsset["media_type"]; reviewStatus?: MediaAsset["review_status"]; ascending?: boolean } = {},
): Promise<MediaAsset[]> {
  let query = supabase
    .from("client_media_assets")
    .select("id, client_id, brief_id, ref_number, media_type, title, storage_path, review_status, member_id, created_at")
    .eq("client_id", clientId);

  if (opts.mediaType) query = query.eq("media_type", opts.mediaType);
  if (opts.reviewStatus) query = query.eq("review_status", opts.reviewStatus);

  const { data } = await query.order("created_at", { ascending: opts.ascending ?? false });
  return (data ?? []) as MediaAsset[];
}

export type ProofAsset = {
  id: string;
  client_id: string;
  media_type: "image" | "text" | "video";
  title: string | null;
  body: string | null;
  storage_path: string | null;
  source: string | null;
  created_at: string;
};

export async function fetchProofAssets(
  clientId: string,
  mediaType?: ProofAsset["media_type"],
): Promise<ProofAsset[]> {
  let query = supabase
    .from("client_proof_assets")
    .select("id, client_id, media_type, title, body, storage_path, source, created_at")
    .eq("client_id", clientId);
  if (mediaType) query = query.eq("media_type", mediaType);

  const { data } = await query.order("created_at", { ascending: false });
  return (data ?? []) as ProofAsset[];
}

export function shortDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}
