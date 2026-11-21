import katex from "katex";
import "katex/dist/katex.min.css";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { SafeArea, centeredTextRegion, useStage } from "../primitives/Stage.js";

export const name = "Equation";
export const schema = z.strictObject({ latex: z.string().trim().min(1).max(200), highlightTerms: z.array(z.string().trim().min(1).max(30)).max(5).optional() });
export type Props = z.infer<typeof schema>;
export const catalogueText = "Presents a short mathematical relationship rendered by KaTeX. Verify the formula and define each symbol in narration; avoid equations that need a full proof.";
export const textRegion = (aspect: Parameters<typeof centeredTextRegion>[0]) => ({ ...centeredTextRegion(aspect), y: 0.3, height: 0.4 });

export function Component({ latex, highlightTerms = [] }: Props) {
  const { theme, aspect } = useStage();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const html = katex.renderToString(latex, { throwOnError: true, trust: false, output: "html" });
  const active = Math.min(highlightTerms.length - 1, Math.floor(frame / Math.max(1, fps * 0.7)));
  return <SafeArea style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 50, textAlign: "center" }}>
    <div style={{ fontSize: aspect === "9:16" ? 76 : 105, color: theme.tokens.colours.primary, maxWidth: "100%", overflow: "hidden" }} dangerouslySetInnerHTML={{ __html: html }} />
    {highlightTerms.length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: 18, justifyContent: "center" }}>{highlightTerms.map((term, index) => <div key={`${index}-${term}`} style={{ padding: "12px 24px", borderRadius: theme.tokens.radii.pill, background: index === active ? theme.tokens.colours.accent : theme.tokens.colours.surface, fontSize: 32, fontWeight: 700 }}>{term}</div>)}</div>}
  </SafeArea>;
}
