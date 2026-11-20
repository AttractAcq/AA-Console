import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { SafeArea, centeredTextRegion, useStage } from "../primitives/Stage.js";

export const name = "BulletReveal";
export const schema = z.strictObject({
  heading: z.string().trim().max(50).optional(),
  items: z.array(z.string().trim().min(1).max(48)).min(2).max(6),
  revealAt: z.array(z.number().finite().nonnegative()).optional(),
}).refine((value) => !value.revealAt || value.revealAt.length === value.items.length, "One reveal time per item");
export type Props = z.infer<typeof schema>;
export const catalogueText = "Explains two to six short supporting points with a paced reveal. Avoid long paragraphs and use supplied alignment times when narration must match an item.";
export const textRegion = (aspect: Parameters<typeof centeredTextRegion>[0]) => ({ ...centeredTextRegion(aspect), y: 0.23, height: 0.53 });
export function Component({ heading, items, revealAt }: Props) {
  const { theme, aspect } = useStage();
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const interval = Math.max(12, Math.floor(durationInFrames * 0.65 / items.length));
  return <SafeArea style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: aspect === "9:16" ? 36 : 25 }}>
    {heading && <div style={{ fontFamily: theme.tokens.type.heading, fontSize: aspect === "9:16" ? 60 : 70, fontWeight: 800, lineHeight: 1.12, marginBottom: 22 }}>{heading}</div>}
    {items.map((item, index) => {
      const at = revealAt ? Math.round(revealAt[index]! * fps) : index * interval;
      const opacity = interpolate(frame, [at, at + 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
      return <div key={index} style={{ display: "flex", alignItems: "flex-start", gap: 25, fontSize: aspect === "9:16" ? 43 : 48, lineHeight: 1.18, opacity, transform: `translateX(${(1 - opacity) * 25}px)` }}>
        <span style={{ color: theme.tokens.colours.secondary, fontWeight: 900 }}>●</span><span>{item}</span>
      </div>;
    })}
  </SafeArea>;
}
