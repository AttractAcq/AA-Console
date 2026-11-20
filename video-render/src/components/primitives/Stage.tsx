import { createContext, useContext, type CSSProperties, type PropsWithChildren } from "react";
import { AbsoluteFill } from "remotion";
import { z } from "zod";
import { buildTheme, type Theme } from "../../brand/theme.js";

export const AspectSchema = z.enum(["16:9", "9:16", "1:1"]);
export type Aspect = z.infer<typeof AspectSchema>;
export const DIMENSIONS: Record<Aspect, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
};
export const SAFE_AREAS: Record<Aspect, { x: number; y: number }> = {
  "16:9": { x: 0.08, y: 0.1 },
  "9:16": { x: 0.09, y: 0.13 },
  "1:1": { x: 0.09, y: 0.11 },
};

export interface StageContextValue { aspect: Aspect; theme: Theme }
const Context = createContext<StageContextValue | null>(null);

export function useStage(): StageContextValue {
  const value = useContext(Context);
  if (!value) throw new Error("Explanation components must render inside Stage");
  return value;
}

export function Stage({ aspect, theme, children }: PropsWithChildren<StageContextValue>) {
  AspectSchema.parse(aspect);
  const safe = SAFE_AREAS[aspect];
  const style = {
    backgroundColor: theme.tokens.colours.background,
    color: theme.tokens.colours.text,
    fontFamily: theme.tokens.type.body,
    "--safe-x": `${safe.x * 100}%`,
    "--safe-y": `${safe.y * 100}%`,
  } as CSSProperties;
  return <Context.Provider value={{ aspect, theme }}><AbsoluteFill style={style}>{children}</AbsoluteFill></Context.Provider>;
}

export function SafeArea({ children, style }: PropsWithChildren<{ style?: CSSProperties }>) {
  const { aspect } = useStage();
  const safe = SAFE_AREAS[aspect];
  return <AbsoluteFill style={{ padding: `${safe.y * 100}% ${safe.x * 100}%`, boxSizing: "border-box", ...style }}>{children}</AbsoluteFill>;
}

export type TextRegion = { x: number; y: number; width: number; height: number };
export function centeredTextRegion(aspect: Aspect): TextRegion {
  const safe = SAFE_AREAS[aspect];
  return { x: safe.x, y: safe.y, width: 1 - safe.x * 2, height: 1 - safe.y * 2 };
}

export const AA_THEME = buildTheme(null);
