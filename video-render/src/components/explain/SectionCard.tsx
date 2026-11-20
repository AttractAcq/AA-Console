import { interpolate, useCurrentFrame } from "remotion";
import { z } from "zod";
import { SafeArea, centeredTextRegion, useStage } from "../primitives/Stage.js";

export const name = "SectionCard";
export const schema = z.strictObject({ index: z.number().int().min(1).max(9), title: z.string().trim().min(1).max(50) });
export type Props = z.infer<typeof schema>;
export const catalogueText = "Introduces one numbered chapter and emits its chapter marker. Use between ideas, not between every sentence. At most nine chapters.";
export const textRegion = (aspect: Parameters<typeof centeredTextRegion>[0]) => ({ ...centeredTextRegion(aspect), y: 0.37, height: 0.28 });
export function Component({ index, title }: Props) {
  const { theme, aspect } = useStage();
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });
  return <SafeArea style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 26, opacity }}>
    <div style={{ color: theme.tokens.colours.secondary, fontSize: 40, fontWeight: 800, letterSpacing: 4 }}>CHAPTER {String(index).padStart(2, "0")}</div>
    <div style={{ fontFamily: theme.tokens.type.heading, fontWeight: 800, fontSize: aspect === "9:16" ? 74 : 92, lineHeight: 1.08 }}>{title}</div>
  </SafeArea>;
}
