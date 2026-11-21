import { useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { SafeArea, centeredTextRegion, useStage } from "../primitives/Stage.js";

export const name = "CodeBlock";
export const schema = z.strictObject({
  language: z.string().trim().min(1).max(20),
  code: z.string().min(1).max(600),
  revealLines: z.array(z.array(z.number().int().nonnegative()).min(1)).max(12).optional(),
}).superRefine((value, ctx) => {
  const count = value.code.split("\n").length;
  if (value.revealLines?.some((group) => group.some((index) => index >= count))) ctx.addIssue({ code: "custom", message: "Reveal line outside code" });
});
export type Props = z.infer<typeof schema>;
export const catalogueText = "Explains a short code example with groups of lines revealed in order. Use only when code is central to the explanation; keep within 600 characters.";
export const textRegion = (aspect: Parameters<typeof centeredTextRegion>[0]) => ({ ...centeredTextRegion(aspect), y: 0.18, height: 0.59 });
export function Component({ language, code, revealLines }: Props) {
  const { theme, aspect } = useStage();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const lines = code.split("\n");
  const visibleGroup = Math.floor(frame / Math.max(1, fps * 0.6));
  const visible = new Set(revealLines ? revealLines.slice(0, visibleGroup + 1).flat() : lines.map((_, index) => index));
  return <SafeArea style={{ display: "flex", flexDirection: "column", justifyContent: "center" }}>
    <div style={{ borderRadius: theme.tokens.radii.card, background: theme.tokens.colours.primary, color: "#FFFFFF", overflow: "hidden", maxHeight: "100%" }}>
      <div style={{ padding: "18px 36px", background: theme.tokens.colours.secondary, fontSize: 27, fontWeight: 700 }}>{language}</div>
      <pre style={{ margin: 0, padding: 36, fontFamily: theme.tokens.type.mono, fontSize: aspect === "9:16" ? 28 : 33, lineHeight: 1.42, overflow: "hidden", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{lines.map((line, index) => <div key={index} style={{ minHeight: "1.42em", opacity: visible.has(index) ? 1 : 0.12 }}>{line || " "}</div>)}</pre>
    </div>
  </SafeArea>;
}
