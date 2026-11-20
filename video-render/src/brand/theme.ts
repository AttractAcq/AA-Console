import { AA_BRAND, BrandTokensSchema, VideoTokenOverridesSchema } from "./tokens.js";
import type { BrandTokens, VideoTokenOverrides } from "./tokens.js";

export interface ClientBrandRow {
  colour_primary?: string | null;
  colour_secondary?: string | null;
  colour_accent?: string | null;
  colour_background?: string | null;
  colour_text?: string | null;
  font_heading?: string | null;
  font_body?: string | null;
  video_tokens?: unknown;
}

export interface Theme {
  tokens: BrandTokens;
  captionText: string;
  captionBackground: string;
  captionContrast: number;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

export function contrastRatio(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function readableText(background: string, requested: string): string {
  if (contrastRatio(background, requested) >= 4.5) return requested;
  return contrastRatio(background, "#FFFFFF") >= contrastRatio(background, "#000000")
    ? "#FFFFFF" : "#000000";
}

function optionalHex(value: string | null | undefined): string | undefined {
  return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : undefined;
}

function optionalFont(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function parseVideoTokenOverrides(value: unknown): VideoTokenOverrides {
  return VideoTokenOverridesSchema.parse(value ?? {});
}

export function buildTheme(row: ClientBrandRow | null): Theme {
  const override = parseVideoTokenOverrides(row?.video_tokens);
  const colours = {
    ...AA_BRAND.colours,
    ...(optionalHex(row?.colour_primary) && { primary: row!.colour_primary! }),
    ...(optionalHex(row?.colour_secondary) && { secondary: row!.colour_secondary! }),
    ...(optionalHex(row?.colour_accent) && { accent: row!.colour_accent! }),
    ...(optionalHex(row?.colour_background) && { background: row!.colour_background! }),
    ...(optionalHex(row?.colour_text) && { text: row!.colour_text! }),
    ...override.colours,
  };
  const tokens = BrandTokensSchema.parse({
    ...AA_BRAND,
    colours,
    dark: { ...AA_BRAND.dark, ...override.dark },
    type: {
      ...AA_BRAND.type,
      ...(optionalFont(row?.font_heading) && { heading: row!.font_heading!.trim() }),
      ...(optionalFont(row?.font_body) && { body: row!.font_body!.trim() }),
      ...override.type,
      scale: { ...AA_BRAND.type.scale, ...override.type?.scale },
    },
    spacing: override.spacing ?? AA_BRAND.spacing,
    radii: { ...AA_BRAND.radii, ...override.radii },
    strokes: { ...AA_BRAND.strokes, ...override.strokes },
    iconStyle: override.iconStyle ?? AA_BRAND.iconStyle,
  });
  const captionBackground = tokens.colours.background;
  const captionText = readableText(captionBackground, tokens.colours.text);
  return { tokens, captionText, captionBackground,
    captionContrast: contrastRatio(captionBackground, captionText) };
}
