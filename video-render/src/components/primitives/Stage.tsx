import { createContext, useContext, type CSSProperties, type PropsWithChildren } from "react";
import { AbsoluteFill } from "remotion";
import { z } from "zod";
import { buildTheme, type Theme } from "../../brand/theme.js";
import { SAFE_AREAS as SAFE_PIXELS } from "../../brand/motion.js";

export const AspectSchema = z.enum(["16:9", "9:16", "1:1"]);
export type Aspect = z.infer<typeof AspectSchema>;
export const DIMENSIONS: Record<Aspect, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
};
export const SAFE_AREAS: Record<Aspect, { x: number; y: number }> = SAFE_PIXELS;

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
    "--safe-x": `${safe.x}px`,
    "--safe-y": `${safe.y}px`,
  } as CSSProperties;
  return <Context.Provider value={{ aspect, theme }}><AbsoluteFill style={style}>{children}</AbsoluteFill></Context.Provider>;
}

export function SafeArea({ children, style }: PropsWithChildren<{ style?: CSSProperties }>) {
  const { aspect } = useStage();
  const safe = SAFE_AREAS[aspect];
  return <AbsoluteFill style={{ padding: `${safe.y}px ${safe.x}px`, boxSizing: "border-box", ...style }}>{children}</AbsoluteFill>;
}

export type TextRegion = { x: number; y: number; width: number; height: number };
export function centeredTextRegion(aspect: Aspect): TextRegion {
  const safe = SAFE_AREAS[aspect];
  const size = DIMENSIONS[aspect];
  const x = safe.x / size.width;
  const y = safe.y / size.height;
  return { x, y, width: 1 - x * 2, height: 1 - y * 2 };
}

export const AA_THEME = buildTheme(null);
