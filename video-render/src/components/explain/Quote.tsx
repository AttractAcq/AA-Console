import { z } from "zod";
import { SafeArea, centeredTextRegion, useStage } from "../primitives/Stage.js";

export const name = "Quote";
export const schema = z.strictObject({ text: z.string().trim().min(1).max(180), attribution: z.string().trim().max(60).optional() });
export type Props = z.infer<typeof schema>;
export const catalogueText = "Displays a brief attributed quotation. Quote wording and permission must be checked against its source before publication.";
export const textRegion = (aspect: Parameters<typeof centeredTextRegion>[0]) => ({ ...centeredTextRegion(aspect), y: 0.27, height: 0.48 });
export function Component({ text, attribution }: Props) {
  const { theme, aspect } = useStage();
  return <SafeArea style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 24 }}>
    <div aria-hidden style={{ color: theme.tokens.colours.accent, fontSize: 160, lineHeight: 0.5, fontFamily: "Georgia, serif" }}>“</div>
    <div style={{ fontSize: aspect === "9:16" ? 57 : 67, fontWeight: 700, lineHeight: 1.18, maxWidth: 1500 }}>{text}</div>
    {attribution && <div style={{ fontSize: 34, color: theme.tokens.colours.muted, marginTop: 25 }}>— {attribution}</div>}
  </SafeArea>;
}
