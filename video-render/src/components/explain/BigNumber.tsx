import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { SafeArea, centeredTextRegion, useStage } from "../primitives/Stage.js";

export const name = "BigNumber";
export const schema = z.strictObject({
  value: z.number().finite(), unit: z.string().trim().max(8).optional(), label: z.string().trim().min(1).max(60), from: z.number().finite().optional(),
});
export type Props = z.infer<typeof schema>;
export const catalogueText = "Emphasizes one sourced numerical fact with an animated count and short label. Supply only a verified value; the component does not validate its provenance.";
export const textRegion = (aspect: Parameters<typeof centeredTextRegion>[0]) => ({ ...centeredTextRegion(aspect), y: 0.31, height: 0.38 });
export function Component({ value, from = 0, unit, label }: Props) {
  const { theme, aspect } = useStage();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({ fps, frame, config: { damping: 200 }, durationInFrames: fps * 1.2 });
  const current = interpolate(progress, [0, 1], [from, value]);
  const rounded = Number.isInteger(value) && Number.isInteger(from) ? Math.round(current).toLocaleString("en-US") : current.toFixed(1);
  return <SafeArea style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", gap: 25 }}>
    <div style={{ color: theme.tokens.colours.primary, fontFamily: theme.tokens.type.heading, fontSize: aspect === "9:16" ? 170 : 210, lineHeight: 1, fontWeight: 850 }}>{rounded}{unit && <span style={{ fontSize: "0.48em", marginLeft: /^[a-z]/i.test(unit) ? 16 : 0 }}>{unit}</span>}</div>
    <div style={{ fontSize: aspect === "9:16" ? 40 : 48, color: theme.tokens.colours.muted, maxWidth: 1250 }}>{label}</div>
  </SafeArea>;
}
