import { z } from "zod";

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex colour");
const Positive = z.number().finite().positive();
const NonNegative = z.number().finite().nonnegative();

export const ColourRole = z.enum([
  "background", "surface", "primary", "secondary", "accent",
  "text", "muted", "success", "warning",
]);

const ColourMap = z.strictObject(Object.fromEntries(
  ColourRole.options.map((role) => [role, Hex]),
) as Record<z.infer<typeof ColourRole>, typeof Hex>);

export const BrandTokensSchema = z.strictObject({
  colours: ColourMap,
  dark: ColourMap.partial(),
  type: z.strictObject({
    heading: z.string().trim().min(1).max(180),
    body: z.string().trim().min(1).max(180),
    mono: z.string().trim().min(1).max(180),
    scale: z.strictObject({
      display: Positive, h1: Positive, h2: Positive,
      body: Positive, caption: Positive,
    }),
  }),
  spacing: Positive,
  radii: z.strictObject({ card: NonNegative, pill: NonNegative }),
  strokes: z.strictObject({ thin: Positive, regular: Positive, bold: Positive }),
  iconStyle: z.enum(["outline", "duotone", "solid"]),
});

export type BrandTokens = z.infer<typeof BrandTokensSchema>;

export const VideoTokenOverridesSchema = z.strictObject({
  colours: ColourMap.partial().optional(),
  dark: ColourMap.partial().optional(),
  type: z.strictObject({
    heading: z.string().trim().min(1).max(180).optional(),
    body: z.string().trim().min(1).max(180).optional(),
    mono: z.string().trim().min(1).max(180).optional(),
    scale: BrandTokensSchema.shape.type.shape.scale.partial().optional(),
  }).optional(),
  spacing: Positive.optional(),
  radii: BrandTokensSchema.shape.radii.partial().optional(),
  strokes: BrandTokensSchema.shape.strokes.partial().optional(),
  iconStyle: BrandTokensSchema.shape.iconStyle.optional(),
});

export type VideoTokenOverrides = z.infer<typeof VideoTokenOverridesSchema>;

// The five source colours and two font values are the in-house AA client's
// recorded Brand & Design values on 20 November 2026. Remaining renderer roles
// are explicit defaults rather than inferred from a prompt.
export const AA_BRAND: BrandTokens = BrandTokensSchema.parse({
  colours: {
    background: "#F5F7F3", surface: "#FFFFFF", primary: "#142B23",
    secondary: "#254D38", accent: "#D8EDB4", text: "#192925",
    muted: "#5E6D63", success: "#167245", warning: "#9B5700",
  },
  dark: {
    background: "#101B16", surface: "#192A20", text: "#F5F7F3",
    muted: "#A8B7A8", accent: "#D8EDB4",
  },
  type: {
    heading: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    body: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    scale: { display: 92, h1: 72, h2: 54, body: 40, caption: 34 },
  },
  spacing: 12,
  radii: { card: 24, pill: 999 },
  strokes: { thin: 2, regular: 4, bold: 8 },
  iconStyle: "outline",
});
