/** Resolve current public words without signing media or calling a provider. */
import type { SupabaseClient } from "@supabase/supabase-js";

export async function resolveProofSummary(
  sb: SupabaseClient,
  placement: { artifact_version_id: string | null; proof_id: string | null; asset_id: string | null },
): Promise<string> {
  if (placement.artifact_version_id) {
    const { data, error } = await sb.from("proof_artifact_versions")
      .select("content").eq("id", placement.artifact_version_id).maybeSingle();
    if (error || !data?.content?.trim()) throw new Error("Artifact content unavailable for readback.");
    return data.content.trim();
  }
  if (placement.proof_id) {
    const { data, error } = await sb.from("client_proof_assets")
      .select("claim,evidence,body").eq("id", placement.proof_id).maybeSingle();
    if (error || !data) throw new Error("Proof content unavailable for readback.");
    const summary = [data.claim?.trim(), (data.evidence ?? data.body)?.trim()]
      .filter(Boolean).join("\n\n");
    if (!summary) throw new Error("Proof content unavailable for readback.");
    return summary;
  }
  const { data, error } = await sb.from("client_media_assets")
    .select("caption").eq("id", placement.asset_id ?? "").maybeSingle();
  if (error || !data) throw new Error("Media caption unavailable for readback.");
  return data.caption?.trim() ?? "";
}
