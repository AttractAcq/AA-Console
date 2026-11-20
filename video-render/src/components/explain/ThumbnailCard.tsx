import { z } from "zod";
import { SafeArea, centeredTextRegion, useStage } from "../primitives/Stage.js";

export const name = "ThumbnailCard";
export const schema = z.strictObject({ hook: z.string().trim().min(1).max(40), kicker: z.string().trim().max(20).optional() });
export type Props = z.infer<typeof schema>;
export const catalogueText = "Still-image cover with one concise hook. Do not use as a timed video scene; it is designed for thumbnails only.";
export const textRegion = (aspect: Parameters<typeof centeredTextRegion>[0]) => ({ ...centeredTextRegion(aspect), y: 0.25, height: 0.5 });
export function Component({ hook, kicker }: Props) {
  const { theme, aspect } = useStage();
  return <SafeArea style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 40, background: `linear-gradient(135deg, ${theme.tokens.colours.background} 0%, ${theme.tokens.colours.accent} 100%)` }}>
    {kicker && <div style={{ textTransform: "uppercase", letterSpacing: 3, fontWeight: 800, fontSize: 31, color: theme.tokens.colours.secondary }}>{kicker}</div>}
    <div style={{ fontFamily: theme.tokens.type.heading, fontWeight: 850, fontSize: aspect === "9:16" ? 90 : 112, lineHeight: 1.08, maxWidth: 1500 }}>{hook}</div>
  </SafeArea>;
}
