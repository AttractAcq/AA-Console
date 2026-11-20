import { Composition } from "remotion";
import { z } from "zod";
import { AA_THEME, AspectSchema, DIMENSIONS, Stage } from "./components/primitives/Stage.js";
import { registry, type ComponentName } from "./ir/registry.js";
import { demoFixtures } from "./ir/demo-fixtures.js";
import { GoldVideo, goldDuration, validateGoldFixture } from "./compositions/GoldVideo.js";
import { GOLD_FIXTURE } from "./compositions/gold-fixture.generated.js";

const ComponentNameSchema = z.enum(Object.keys(registry) as [ComponentName, ...ComponentName[]]);
const DemoSchema = z.strictObject({ aspect: AspectSchema, kind: ComponentNameSchema, props: z.unknown() });

function Demo(input: z.infer<typeof DemoSchema>) {
  const { aspect, kind, props } = DemoSchema.parse(input);
  const entry = registry[kind];
  const validated = entry.schema.parse(props);
  const Component = entry.Component as React.ComponentType<any>;
  return <Stage aspect={aspect} theme={AA_THEME}><Component {...validated} /></Stage>;
}

export function RemotionRoot() {
  return <>
    {AspectSchema.options.map((aspect) => {
      const { width, height } = DIMENSIONS[aspect];
      const fixture = validateGoldFixture(GOLD_FIXTURE);
      return <Composition
        key={`Gold-${aspect}`}
        id={`Gold-${aspect.replace(":", "x")}`}
        component={GoldVideo}
        durationInFrames={goldDuration(fixture)}
        fps={30}
        width={width}
        height={height}
        defaultProps={{ aspect, scenes: fixture.scenes }}
        calculateMetadata={({ props: supplied }) => {
          const parsed = validateGoldFixture({ scenes: supplied.scenes });
          return { durationInFrames: goldDuration(parsed) };
        }}
      />;
    })}
    {Object.keys(registry).flatMap((id) => AspectSchema.options.map((aspect) => {
    const { width, height } = DIMENSIONS[aspect];
    const props = demoFixtures[id as ComponentName];
    return <Composition
      key={`${id}-${aspect}`}
      id={`${id}-${aspect.replace(":", "x")}`}
      component={Demo}
      durationInFrames={id === "ThumbnailCard" ? 1 : 150}
      fps={30}
      width={width}
      height={height}
      defaultProps={{ aspect, kind: id as ComponentName, props }}
      calculateMetadata={({ props: supplied }) => {
        const parsed = DemoSchema.parse(supplied);
        registry[parsed.kind].schema.parse(parsed.props);
        return {};
      }}
    />;
    }))}
  </>;
}
