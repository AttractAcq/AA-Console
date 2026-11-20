import { TransitionSeries, type TransitionPresentation } from "@remotion/transitions";
import { z } from "zod";
import { AA_THEME, AspectSchema, Stage } from "../components/primitives/Stage.js";
import { transitionPreset, TransitionNameSchema } from "../components/primitives/TransitionPresets.js";
import { registry, type ComponentName } from "../ir/registry.js";

const ComponentNameSchema = z.enum(Object.keys(registry) as [ComponentName, ...ComponentName[]]);
export const GoldSceneSchema = z.strictObject({
  id: z.string().regex(/^s0[1-9]$/), component: ComponentNameSchema, props: z.unknown(),
  narration: z.string().trim().min(1).max(600),
  transitionIn: TransitionNameSchema,
  durationInFrames: z.number().int().positive(),
});
export const GoldFixtureSchema = z.strictObject({ scenes: z.array(GoldSceneSchema).length(9) });
export type GoldFixture = z.infer<typeof GoldFixtureSchema>;

export function validateGoldFixture(value: unknown): GoldFixture {
  const fixture = GoldFixtureSchema.parse(value);
  fixture.scenes.forEach((scene, index) => {
    if (scene.id !== `s${String(index + 1).padStart(2, "0")}`) throw new Error(`Unexpected scene ID ${scene.id}`);
    if (index === 0 && (scene.component !== "TitleCard" || scene.transitionIn !== "cut")) throw new Error("Gold fixture must open with TitleCard and cut");
    if (index === 8 && scene.component !== "Outro") throw new Error("Gold fixture must end with Outro");
    if (index > 0 && scene.transitionIn === "cut") throw new Error("Gold fixture needs a timed transition between scenes");
    registry[scene.component].schema.parse(scene.props);
  });
  if (goldDuration(fixture) !== 3600) throw new Error("Gold fixture must run exactly two minutes at 30 fps");
  return fixture;
}

export function goldDuration(fixture: GoldFixture): number {
  return fixture.scenes.reduce((total, scene, index) => total + scene.durationInFrames - (index > 0 && scene.transitionIn !== "cut" ? 18 : 0), 0);
}

export function GoldVideo(input: { aspect: z.infer<typeof AspectSchema>; scenes: unknown[] }) {
  const aspect = AspectSchema.parse(input.aspect);
  const fixture = validateGoldFixture({ scenes: input.scenes });
  const elements: React.ReactNode[] = [];
  fixture.scenes.forEach((scene, index) => {
    if (index > 0) {
      const preset = transitionPreset(scene.transitionIn, AA_THEME.tokens.colours.primary, 18);
      if (!preset) throw new Error("Expected a timed scene transition");
      elements.push(<TransitionSeries.Transition key={`transition-${scene.id}`} presentation={preset.presentation as TransitionPresentation<any>} timing={preset.timing} />);
    }
    const entry = registry[scene.component];
    const Component = entry.Component as React.ComponentType<any>;
    elements.push(<TransitionSeries.Sequence key={scene.id} durationInFrames={scene.durationInFrames}>
      <Component {...entry.schema.parse(scene.props)} />
    </TransitionSeries.Sequence>);
  });
  return <Stage aspect={aspect} theme={AA_THEME}><TransitionSeries>{elements}</TransitionSeries></Stage>;
}
