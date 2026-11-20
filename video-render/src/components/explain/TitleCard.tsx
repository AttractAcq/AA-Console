import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { useStage, SafeArea, centeredTextRegion } from "../primitives/Stage.js";

export const name = "TitleCard";
export const schema = z.strictObject({
  title: z.string().trim().min(1).max(60),
  subtitle: z.string().trim().max(90).optional(),
  kicker: z.string().trim().max(24).optional(),
});
export type Props = z.infer<typeof schema>;
export const catalogueText = "Opens a video or a major section with one clear promise. Avoid dense explanations and unverified outcome claims. Title limit: 60 characters.";
export const textRegion = (aspect: Parameters<typeof centeredTextRegion>[0]) => ({ ...centeredTextRegion(aspect), y: 0.34, height: 0.34 });

export function Component(props: Props) {
  const { theme, aspect } = useStage();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rise = interpolate(frame, [0, fps * 0.55], [32, 0], { extrapolateRight: "clamp" });
  const alpha = interpolate(frame, [0, fps * 0.45], [0, 1], { extrapolateRight: "clamp" });
  const vertical = aspect === "9:16";
  return <SafeArea style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 28, overflow: "hidden" }}>
    {props.kicker && <div style={{ color: theme.tokens.colours.secondary, fontSize: vertical ? 30 : 33, fontWeight: 700, letterSpacing: 3, textTransform: "uppercase", opacity: alpha }}>{props.kicker}</div>}
    <div style={{ fontFamily: theme.tokens.type.heading, fontSize: vertical ? 76 : theme.tokens.type.scale.display, fontWeight: 800, lineHeight: 1.08, maxWidth: 1400, transform: `translateY(${rise}px)`, opacity: alpha }}>{props.title}</div>
    {props.subtitle && <div style={{ fontSize: vertical ? 36 : theme.tokens.type.scale.body, lineHeight: 1.3, maxWidth: 1300, color: theme.tokens.colours.muted, opacity: alpha }}>{props.subtitle}</div>}
    <div style={{ background: theme.tokens.colours.accent, width: vertical ? 180 : 240, height: 12, borderRadius: 8, marginTop: 16, opacity: alpha }} />
  </SafeArea>;
}
