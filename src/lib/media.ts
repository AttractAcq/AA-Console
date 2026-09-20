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

/**
 * A text asset's file IS the content, so fetch it from the signed URL.
 * Capped and best-effort: one unreadable file must not blank the whole list.
 */
export async function fetchTextBodies(
  rows: Array<{ id: string; storage_path: string }>,
  signed: Map<string, string>,
  limit = 30,
): Promise<Map<string, string>> {
  const fetched = new Map<string, string>();
  await Promise.all(
    rows.slice(0, limit).map(async (row) => {
      const url = signed.get(row.storage_path);
      if (!url) return;
      try {
        const response = await fetch(url);
        if (response.ok) fetched.set(row.id, (await response.text()).slice(0, 4000));
      } catch {
        // leave it out; the card falls back to its icon
      }
    }),
  );
  return fetched;
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
  /** Null unless a person approved it. A bot approval never sets this. */
  human_approved_at?: string | null;
  content_format?: "single" | "carousel" | "story";
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
  opts: {
    mediaType?: MediaAsset["media_type"];
    reviewStatus?: MediaAsset["review_status"];
    ascending?: boolean;
    /** Default client so hiring ads never appear in campaign Media / Dist / Approvals. */
    purpose?: "client" | "recruitment" | "all";
    /**
     * true  — only what a person signed off, which is what schedule_asset takes
     * false — still needs a person, including anything only a bot approved
     *
     * review_status alone cannot tell these apart: a bot approval sets it too.
     */
    humanApproved?: boolean;
    /** "single" for the plain libraries; "carousel"/"story" for the frame ones. */
    contentFormat?: "single" | "carousel" | "story";
  } = {},
): Promise<MediaAsset[]> {
  let query = supabase
    .from("client_media_assets")
    .select("id, client_id, brief_id, ref_number, media_type, title, storage_path, review_status, human_approved_at, content_format, member_id, created_at")
    .eq("client_id", clientId);

  if (opts.mediaType) query = query.eq("media_type", opts.mediaType);
  if (opts.reviewStatus) query = query.eq("review_status", opts.reviewStatus);
  if (opts.humanApproved === true) query = query.not("human_approved_at", "is", null);
  if (opts.humanApproved === false) query = query.is("human_approved_at", null);
  if (opts.contentFormat) query = query.eq("content_format", opts.contentFormat);
  const purpose = opts.purpose ?? "client";
  if (purpose !== "all") {
    query = query.eq("purpose", purpose);
  }

  const { data, error } = await query.order("created_at", { ascending: opts.ascending ?? false });
  if (error) throw error;
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
  // Proof & Asset OS. Null on records filed before it existed, which is why
  // the panel shows what still needs structuring rather than assuming.
  ref_number: string | null;
  proof_type: string | null;
  claim: string | null;
  evidence: string | null;
  avatar_relevance: string | null;
  services: string | null;
  strength: string;
  usage_rights: string;
  captured_on: string | null;
  expires_on: string | null;
};

export async function fetchProofAssets(
  clientId: string,
  mediaType?: ProofAsset["media_type"],
): Promise<ProofAsset[]> {
  let query = supabase
    .from("client_proof_assets")
    .select(
      "id, client_id, media_type, title, body, storage_path, source, created_at, ref_number, proof_type, claim, evidence, avatar_relevance, services, strength, usage_rights, captured_on, expires_on",
    )
    .eq("client_id", clientId);
  if (mediaType) query = query.eq("media_type", mediaType);

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as ProofAsset[];
}

export function shortDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}
