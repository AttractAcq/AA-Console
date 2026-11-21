import { z } from "zod";
import { SafeArea, centeredTextRegion, useStage } from "../primitives/Stage.js";

const SideSchema = z.strictObject({ title: z.string().trim().min(1).max(35), points: z.array(z.string().trim().min(1).max(48)).min(1).max(4) });
export const name = "Compare";
export const schema = z.strictObject({ left: SideSchema, right: SideSchema });
export type Props = z.infer<typeof schema>;
export const catalogueText = "Compares two choices on equal terms, with up to four short points each. It stacks on portrait output. Do not use when the evidence for either side is incomplete.";
export const textRegion = (aspect: Parameters<typeof centeredTextRegion>[0]) => ({ ...centeredTextRegion(aspect), y: 0.23, height: 0.52 });
export function Component({ left, right }: Props) {
  const { theme, aspect } = useStage();
  return <SafeArea style={{ display: "flex", flexDirection: aspect === "9:16" ? "column" : "row", gap: 30, justifyContent: "center" }}>
    {[left, right].map((side, index) => <div key={index} style={{ flex: 1, padding: aspect === "9:16" ? 42 : 54, borderRadius: theme.tokens.radii.card, background: index === 0 ? theme.tokens.colours.surface : theme.tokens.colours.primary, color: index === 0 ? theme.tokens.colours.text : "#FFFFFF", display: "flex", flexDirection: "column", justifyContent: "center" }}>
      <div style={{ fontSize: aspect === "9:16" ? 48 : 58, fontWeight: 800, marginBottom: 28 }}>{side.title}</div>
      {side.points.map((point, pointIndex) => <div key={pointIndex} style={{ fontSize: aspect === "9:16" ? 32 : 37, lineHeight: 1.24, marginTop: 16 }}>• {point}</div>)}
    </div>)}
  </SafeArea>;
}
