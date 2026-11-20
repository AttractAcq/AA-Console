import { z } from "zod";
import { SafeArea, centeredTextRegion, useStage } from "../primitives/Stage.js";

export const name = "Outro";
export const schema = z.strictObject({ headline: z.string().trim().min(1).max(50), cta: z.string().trim().min(1).max(40), url: z.string().trim().max(40).optional() });
export type Props = z.infer<typeof schema>;
export const catalogueText = "Ends the video with one next action. Always use as the final scene; do not add multiple competing calls to action.";
export const textRegion = (aspect: Parameters<typeof centeredTextRegion>[0]) => ({ ...centeredTextRegion(aspect), y: 0.31, height: 0.4 });
export function Component({ headline, cta, url }: Props) {
  const { theme, aspect } = useStage();
  return <SafeArea style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 38 }}>
    <div style={{ fontFamily: theme.tokens.type.heading, fontWeight: 800, fontSize: aspect === "9:16" ? 72 : 90, lineHeight: 1.1 }}>{headline}</div>
    <div style={{ alignSelf: "flex-start", background: theme.tokens.colours.primary, color: "#FFFFFF", padding: "24px 40px", borderRadius: theme.tokens.radii.pill, fontSize: 40, fontWeight: 700 }}>{cta}</div>
    {url && <div style={{ fontSize: 31, color: theme.tokens.colours.muted }}>{url}</div>}
  </SafeArea>;
}
