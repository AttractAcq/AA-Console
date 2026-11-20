import { useMemo } from "react";
import { createTikTokStyleCaptions, type Caption } from "@remotion/captions";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { type TextRegion, useStage } from "./Stage.js";

export const CaptionStyleSchema = z.enum(["pill", "plain"]);
export const CaptionLayerSchema = z.strictObject({
  captions: z.array(z.strictObject({
    text: z.string(), startMs: z.number().nonnegative(), endMs: z.number().nonnegative(),
    timestampMs: z.number().nonnegative(), confidence: z.number().nullable(),
  })),
  style: CaptionStyleSchema.default("pill"),
  textRegion: z.strictObject({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
});
export type CaptionLayerProps = { captions: Caption[]; style?: z.infer<typeof CaptionStyleSchema>; textRegion: TextRegion };

function overlaps(a: TextRegion, b: TextRegion) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function captionPlacement(textRegion: TextRegion): "bottom" | "top" | "hidden" {
  const bottom = { x: 0.07, y: 0.79, width: 0.86, height: 0.13 };
  const top = { x: 0.07, y: 0.08, width: 0.86, height: 0.13 };
  if (!overlaps(bottom, textRegion)) return "bottom";
  if (!overlaps(top, textRegion)) return "top";
  return "hidden";
}

export function CaptionLayer({ captions, style = "pill", textRegion }: CaptionLayerProps) {
  CaptionLayerSchema.parse({ captions, style, textRegion });
  const { theme, aspect } = useStage();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pages = useMemo(() => createTikTokStyleCaptions({ captions, combineTokensWithinMilliseconds: 900 }).pages, [captions]);
  const currentMs = frame * 1000 / fps;
  const page = pages.find((candidate, index) => currentMs >= candidate.startMs && currentMs < (pages[index + 1]?.startMs ?? candidate.startMs + candidate.durationMs));
  const placement = captionPlacement(textRegion);
  if (!page || placement === "hidden") return null;
  return <div style={{
    position: "absolute", left: "7%", width: "86%", top: placement === "top" ? "8%" : "79%", height: "13%",
    display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", boxSizing: "border-box",
    padding: "12px 22px", borderRadius: style === "pill" ? theme.tokens.radii.card : 0,
    background: style === "pill" ? theme.captionBackground : "transparent", color: theme.captionText,
    fontSize: aspect === "9:16" ? 40 : 38, fontWeight: 750, lineHeight: 1.18,
    overflow: "hidden", whiteSpace: "pre-wrap", overflowWrap: "anywhere",
  }}><span style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
    {page.tokens.map((token, index) => <span key={`${index}-${token.fromMs}`} style={{ color: currentMs >= token.fromMs && currentMs < token.toMs ? theme.tokens.colours.secondary : theme.captionText }}>{token.text}</span>)}
  </span></div>;
}
