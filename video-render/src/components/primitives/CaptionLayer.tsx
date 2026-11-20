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

type CaptionToken = { text: string; fromMs: number; toMs: number };
export type CaptionPageLayout = { startMs: number; endMs: number; lines: CaptionToken[][] };

export function layoutCaptionPages(captions: Caption[]): CaptionPageLayout[] {
  const sourcePages = createTikTokStyleCaptions({ captions, combineTokensWithinMilliseconds: 900 }).pages;
  const layouts: CaptionPageLayout[] = [];
  for (const source of sourcePages) {
    let lines: CaptionToken[][] = [[]];
    let lineLength = 0;
    const flush = () => {
      const tokens = lines.flat();
      if (tokens.length) layouts.push({ startMs: tokens[0]!.fromMs, endMs: tokens.at(-1)!.toMs, lines });
      lines = [[]];
      lineLength = 0;
    };
    for (const token of source.tokens) {
      const text = token.text.trim();
      const length = Array.from(text).length;
      if (length > 32) throw new Error("Caption word exceeds 32 characters");
      if (!length) continue;
      if (lineLength > 0 && lineLength + 1 + length > 32) {
        if (lines.length === 2) flush();
        else { lines.push([]); lineLength = 0; }
      }
      lines.at(-1)!.push({ text, fromMs: token.fromMs, toMs: token.toMs });
      lineLength += (lineLength ? 1 : 0) + length;
    }
    flush();
  }
  return layouts.map((page, index) => ({ ...page, endMs: Math.min(layouts[index + 1]?.startMs ?? Infinity, page.endMs + 300) }));
}

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
  const pages = useMemo(() => layoutCaptionPages(captions), [captions]);
  const currentMs = frame * 1000 / fps;
  const page = pages.find((candidate) => currentMs >= candidate.startMs && currentMs < candidate.endMs);
  const placement = captionPlacement(textRegion);
  if (!page || placement === "hidden") return null;
  return <div style={{
    position: "absolute", left: "7%", width: "86%", top: placement === "top" ? "8%" : "79%", height: "13%",
    display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", boxSizing: "border-box",
    padding: "12px 22px", borderRadius: style === "pill" ? theme.tokens.radii.card : 0,
    background: style === "pill" ? theme.captionBackground : "transparent", color: theme.captionText,
    fontSize: aspect === "9:16" ? 40 : 38, fontWeight: 750, lineHeight: 1.18,
    overflow: "hidden", whiteSpace: "pre-wrap", overflowWrap: "anywhere",
  }}><span style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
    {page.lines.map((line, lineIndex) => <span key={lineIndex}>
      {line.map((token, index) => <span key={`${index}-${token.fromMs}`} style={{ color: currentMs >= token.fromMs && currentMs < token.toMs ? theme.tokens.colours.secondary : theme.captionText }}>{token.text}{index < line.length - 1 ? " " : ""}</span>)}
    </span>)}
  </span></div>;
}
