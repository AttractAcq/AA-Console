// The client's visual brand, as both stages of a build need to hear it.
//
// Identity taught the lesson this follows: a value is either given verbatim or
// its absence is stated, and there is no third state, because a model told
// nothing invents something plausible. The same is true of a palette. Asked for
// "an on-brand image" with no palette on file, a renderer picks whichever blue
// it likes, and picks a different one next week.
//
// So the two stages are told different things on purpose. The concept stage is
// asked to write art direction *within* the brand. The render stage is given
// the literal hex values, because that is where the pixels are decided.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface BrandProfile {
  colour_primary: string | null;
  colour_secondary: string | null;
  colour_accent: string | null;
  colour_background: string | null;
  colour_text: string | null;
  font_heading: string | null;
  font_body: string | null;
  imagery_style: string | null;
  lighting: string | null;
  mood: string | null;
  composition_notes: string | null;
  never_do: string | null;
}

const COLUMNS =
  "colour_primary, colour_secondary, colour_accent, colour_background, colour_text, " +
  "font_heading, font_body, imagery_style, lighting, mood, composition_notes, never_do";

export async function loadBrandProfile(
  sb: SupabaseClient,
  clientId: string,
): Promise<BrandProfile | null> {
  const { data } = await sb
    .from("client_brand_profiles")
    .select(COLUMNS)
    .eq("client_id", clientId)
    .maybeSingle();
  return (data as BrandProfile | null) ?? null;
}

/** True when the profile carries anything worth telling a model about. */
export function hasBrand(profile: BrandProfile | null): profile is BrandProfile {
  return Boolean(profile && Object.values(profile).some((v) => typeof v === "string" && v.trim()));
}

function palette(profile: BrandProfile): string[] {
  return (
    [
      ["The dominant brand colour", profile.colour_primary],
      ["The secondary colour", profile.colour_secondary],
      ["The accent colour, for the single most important element only", profile.colour_accent],
      ["The background", profile.colour_background],
      ["Text", profile.colour_text],
    ] as Array<[string, string | null]>
  )
    .filter(([, v]) => v)
    .map(([label, v]) => `- ${label}: exactly ${v}`);
}

function treatment(profile: BrandProfile): string[] {
  return (
    [
      ["Imagery", profile.imagery_style],
      ["Lighting", profile.lighting],
      ["Mood", profile.mood],
      ["Composition", profile.composition_notes],
    ] as Array<[string, string | null]>
  )
    .filter(([, v]) => v)
    .map(([label, v]) => `- ${label}: ${v}`);
}

function type(profile: BrandProfile): string[] {
  const lines: string[] = [];
  if (profile.font_heading) lines.push(`- Headings are set in ${profile.font_heading}, or a face that reads as it`);
  if (profile.font_body) lines.push(`- Body text is set in ${profile.font_body}, or a face that reads as it`);
  return lines;
}

/**
 * For the concept stage. The concept writes `art_direction`, so the brand has
 * to constrain what it writes rather than arrive afterwards and contradict it.
 */
export function brandConceptBlock(profile: BrandProfile | null): string {
  if (!hasBrand(profile)) {
    return [
      "BRAND — none on file",
      "No visual brand has been recorded for this client. Choose a palette and treatment that suit the subject,",
      "and state them explicitly in art_direction, so a later asset can be made to match this one.",
    ].join("\n");
  }

  const lines = [...palette(profile), ...type(profile), ...treatment(profile)];
  if (profile.never_do) lines.push(`- Never, for this brand specifically: ${profile.never_do}`);

  return [
    "BRAND — this client's existing visual system",
    ...lines,
    "",
    "Write art_direction so that it EXPRESSES this system rather than replacing it. Do not propose a different",
    "palette, a different typeface or a different treatment because it would suit the subject better — the point",
    "of a brand is that it is the same next time. If the brief genuinely fights the brand, say so in rationale.",
  ].join("\n");
}

/**
 * For the render stage, where the pixels are decided. Hex values are quoted
 * literally: "on brand" means nothing to an image model, "#0064EB" does.
 */
export function brandRenderBlock(profile: BrandProfile | null): string {
  if (!hasBrand(profile)) {
    return [
      "PALETTE",
      "No brand palette is on file. Choose one coherent palette and hold it across the whole image.",
    ].join("\n");
  }

  const lines = [...palette(profile)];
  const t = type(profile);
  const tr = treatment(profile);
  if (t.length) lines.push(...t);
  if (tr.length) lines.push(...tr);
  if (profile.never_do) lines.push(`- This brand never uses: ${profile.never_do}`);

  return [
    "BRAND — USE THESE EXACT VALUES",
    ...lines,
    "These are the client's real brand colours. Use them as the image's actual palette rather than as a loose",
    "suggestion, and do not introduce a competing dominant colour.",
  ].join("\n");
}
