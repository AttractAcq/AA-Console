import { interpolate, useCurrentFrame } from "remotion";
import { z } from "zod";
import { SafeArea, centeredTextRegion, useStage } from "../primitives/Stage.js";

export const name = "StepFlow";
export const schema = z.strictObject({
  steps: z.array(z.strictObject({ label: z.string().trim().min(1).max(28), detail: z.string().trim().max(60).optional() })).min(2).max(6),
  direction: z.enum(["auto", "horizontal", "vertical"]).default("auto"),
});
export type Props = z.infer<typeof schema>;
export const catalogueText = "Shows two to six ordered steps. It stacks vertically on portrait output and runs horizontally on landscape output. Use when order matters, not for unrelated bullets.";
export const textRegion = (aspect: Parameters<typeof centeredTextRegion>[0]) => ({ ...centeredTextRegion(aspect), y: 0.23, height: 0.53 });
export function Component({ steps, direction }: Props) {
  const { theme, aspect } = useStage();
  const frame = useCurrentFrame();
  const vertical = aspect === "9:16" || direction === "vertical";
  return <SafeArea style={{ display: "flex", flexDirection: vertical ? "column" : "row", alignItems: "stretch", justifyContent: "center", gap: 18 }}>
    {steps.map((step, index) => {
      const opacity = interpolate(frame, [index * 10, index * 10 + 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
      return <div key={index} style={{ flex: 1, display: "flex", flexDirection: vertical ? "row" : "column", gap: 18, alignItems: vertical ? "center" : "flex-start", justifyContent: "center", padding: vertical ? 24 : 30, borderRadius: theme.tokens.radii.card, background: theme.tokens.colours.surface, border: `2px solid ${theme.tokens.colours.accent}`, opacity }}>
        <div style={{ flex: "none", width: 65, height: 65, display: "grid", placeItems: "center", borderRadius: 999, background: theme.tokens.colours.primary, color: "#FFFFFF", fontSize: 31, fontWeight: 800 }}>{index + 1}</div>
        <div><div style={{ fontSize: vertical ? 40 : 38, fontWeight: 800 }}>{step.label}</div>{step.detail && <div style={{ marginTop: 12, fontSize: vertical ? 27 : 28, lineHeight: 1.25, color: theme.tokens.colours.muted }}>{step.detail}</div>}</div>
      </div>;
    })}
  </SafeArea>;
}
