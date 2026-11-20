import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { SafeArea, centeredTextRegion, useStage } from "../primitives/Stage.js";

export const name = "KineticHeadline";
export const schema = z.strictObject({
  words: z.array(z.string().trim().min(1).max(24)).min(1).max(12),
  emphasis: z.array(z.number().int().nonnegative()).optional(),
  revealAt: z.array(z.number().finite().nonnegative()).optional(),
}).refine((value) => value.emphasis?.every((index) => index < value.words.length) ?? true, "Emphasis index outside words")
  .refine((value) => !value.revealAt || value.revealAt.length === value.words.length, "One reveal time per word");
export type Props = z.infer<typeof schema>;
export const catalogueText = "A short spoken claim revealed one word at a time. Use for a central takeaway, not a paragraph or unsupported performance claim. Twelve words maximum.";
export const textRegion = (aspect: Parameters<typeof centeredTextRegion>[0]) => ({ ...centeredTextRegion(aspect), y: 0.34, height: 0.36 });
export function Component({ words, emphasis = [], revealAt }: Props) {
  const { theme, aspect } = useStage();
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();
  const stride = Math.max(5, Math.floor(Math.min(durationInFrames * 0.65, 75) / words.length));
  return <SafeArea style={{ display: "flex", alignItems: "center" }}>
    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.2em 0.3em", fontFamily: theme.tokens.type.heading, fontSize: aspect === "9:16" ? 75 : 94, fontWeight: 800, lineHeight: 1.12 }}>
      {words.map((word, index) => {
        const at = revealAt ? Math.round(revealAt[index]! * fps) : index * stride;
        const opacity = interpolate(frame, [at, at + 9], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        return <span key={`${index}-${word}`} style={{ opacity, transform: `translateY(${(1 - opacity) * 22}px)`, color: emphasis.includes(index) ? theme.tokens.colours.secondary : theme.tokens.colours.text }}>{word}</span>;
      })}
    </div>
  </SafeArea>;
}
