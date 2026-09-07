import type { SupabaseClient } from "@supabase/supabase-js";
import { loadUsableProof, renderProof, type ProofRecord } from "../proof.js";
import { loadIdentity, identityWriterBlock, type ClientIdentity } from "../identity.js";
import { loadBrandProfile, hasBrand, type BrandProfile } from "../creative_build/brand.js";

/**
 * Everything the business knows, gathered for the page builder.
 *
 * This is the console's actual job in Conversion Site Builder. Building a page
 * is one model call; knowing what to put in it is the whole of the client's
 * intelligence, and no bot should have to go and assemble that itself. One
 * button, and this is what sits behind it.
 */
export interface PagePackage {
  brand: BrandProfile | null;
  identity: ClientIdentity;
  proof: ProofRecord[];
  proofHeld: number;
}

export async function loadPagePackage(
  sb: SupabaseClient,
  clientId: string,
  clientName: string,
): Promise<PagePackage> {
  const [brand, identity, proof, { count: held }] = await Promise.all([
    loadBrandProfile(sb, clientId),
    loadIdentity(sb, clientId, clientName),
    loadUsableProof(sb, clientId),
    sb
      .from("client_proof_assets")
      .select("id", { count: "exact", head: true })
      .eq("client_id", clientId)
      .neq("usage_rights", "approved"),
  ]);
  return { brand, identity, proof, proofHeld: held ?? 0 };
}

/**
 * The brand, as a page builder needs it: real hex, real families, and the
 * client's own CSS if they have any.
 *
 * client_brand_profiles.custom_css has existed with nothing reading it. This
 * is its first consumer, which is why it is passed through verbatim rather
 * than interpreted — it is the client's own stylesheet, and rewriting it would
 * defeat the point of storing it.
 */
export function brandPageBlock(brand: BrandProfile | null, customCss: string | null): string {
  if (!hasBrand(brand)) {
    return [
      "BRAND — none on file",
      "No visual brand has been recorded. Choose a restrained palette and one typeface pairing,",
      "and keep them consistent across the whole page.",
    ].join("\n");
  }

  const lines: string[] = [];
  const add = (label: string, v: string | null) => {
    if (v) lines.push(`- ${label}: ${v}`);
  };
  add("Primary", brand.colour_primary);
  add("Secondary", brand.colour_secondary);
  add("Accent, for the single most important element only", brand.colour_accent);
  add("Background", brand.colour_background);
  add("Text", brand.colour_text);
  add("Headings set in", brand.font_heading);
  add("Body set in", brand.font_body);
  add("Mood", brand.mood);
  add("Never, for this brand", brand.never_do);

  return [
    "BRAND — use these exact values",
    ...lines,
    "These are real hex values. Use them as the page's palette rather than as inspiration.",
    customCss
      ? `\nTHE CLIENT'S OWN CSS — include this verbatim in your <style> block, then build on top of it:\n${customCss}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The whole package as prompt text, in the order a builder needs it. */
export function renderPackage(pkg: PagePackage, customCss: string | null): string {
  return [
    brandPageBlock(pkg.brand, customCss),
    "",
    identityWriterBlock(pkg.identity),
    "",
    "PROOF CLEARED FOR USE — the only proof this page may state, quoted as given",
    renderProof(pkg.proof, { held: pkg.proofHeld }),
  ].join("\n");
}
