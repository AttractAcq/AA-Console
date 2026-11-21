import type { TransitionPresentation, TransitionPresentationComponentProps } from "@remotion/transitions";
import { linearTiming } from "@remotion/transitions";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import { AbsoluteFill } from "remotion";
import { z } from "zod";

export const TransitionNameSchema = z.enum(["cut", "fade", "slideLeft", "slideUp", "wipeBrand"]);
export type TransitionName = z.infer<typeof TransitionNameSchema>;
type WipeBrandProps = { color: string };
type FadeProps = Record<string, never>;

function FadeThroughBackground({ children, presentationDirection, presentationProgress }: TransitionPresentationComponentProps<FadeProps>) {
  // A two-stage dip keeps text from different scenes from sitting on top of
  // each other. The Stage background remains visible between the two halves.
  const opacity = presentationDirection === "exiting"
    ? 1 - Math.min(1, presentationProgress * 2)
    : Math.max(0, (presentationProgress - 0.5) * 2);
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
}

export function fadeThroughBackground(): TransitionPresentation<FadeProps> {
  return { component: FadeThroughBackground, props: {} };
}

function BrandWipe({ children, passedProps, presentationDirection, presentationProgress }: TransitionPresentationComponentProps<WipeBrandProps>) {
  if (presentationDirection === "exiting") return <AbsoluteFill>{children}</AbsoluteFill>;
  const percentage = Math.max(0, Math.min(100, presentationProgress * 100));
  return <AbsoluteFill>
    <AbsoluteFill style={{ clipPath: `inset(0 ${100 - percentage}% 0 0)` }}>{children}</AbsoluteFill>
    {percentage < 100 && <div aria-hidden style={{ position: "absolute", left: `${percentage}%`, top: 0, bottom: 0, width: 18, background: passedProps.color, transform: "translateX(-50%)" }} />}
  </AbsoluteFill>;
}

export function wipeBrand(color: string): TransitionPresentation<WipeBrandProps> {
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error("Brand wipe needs a six-digit colour");
  return { component: BrandWipe, props: { color } };
}

export function transitionPreset(name: TransitionName, primaryColor: string, durationInFrames = 18) {
  TransitionNameSchema.parse(name);
  if (name === "cut") return null;
  if (!Number.isInteger(durationInFrames) || durationInFrames < 1) throw new Error("Transition duration must be a positive frame count");
  const presentation = name === "fade" ? fadeThroughBackground()
    : name === "slideLeft" ? slide({ direction: "from-right" })
      : name === "slideUp" ? slide({ direction: "from-bottom" })
        : name === "wipeBrand" ? wipeBrand(primaryColor)
          : wipe();
  return { presentation, timing: linearTiming({ durationInFrames }) };
}
