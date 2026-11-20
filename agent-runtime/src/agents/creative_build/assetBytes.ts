import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Bind delivery evidence to the bytes Storage actually returned for this asset. */
export async function registerStoredAssetBytes(
  sb: SupabaseClient,
  bucket: string,
  assetId: string,
  path: string,
  uploaded: Buffer,
): Promise<string> {
  const { data: stored, error: downloadError } = await sb.storage.from(bucket).download(path);
  if (downloadError || !stored) {
    throw new Error(`Could not verify stored asset bytes: ${downloadError?.message ?? "file missing"}`);
  }
  const actual = Buffer.from(await stored.arrayBuffer());
  if (!actual.equals(uploaded)) {
    throw new Error("Stored asset bytes differ from the generated file; review is held.");
  }
  const sha256 = createHash("sha256").update(actual).digest("hex");
  const { error: registerError } = await sb.rpc("register_delivery_asset_bytes_v6", {
    p_asset_id: assetId,
    p_storage_path: path,
    p_sha256: sha256,
  });
  if (registerError) {
    throw new Error(`Could not register asset byte evidence: ${registerError.message}`);
  }
  return sha256;
}
